/**
 * Codex (OpenAI Codex CLI) 适配器。
 *
 * 配置：~/.codex/config.toml（或 $CODEX_HOME/config.toml）
 *   model = "<默认模型>"
 *   model_provider = "wb-switch"
 *   [model_providers.wb-switch]
 *   name = "wb-switch"
 *   base_url = "http://127.0.0.1:7533/v1"
 *   wire_api = "responses"          ← Codex 只支持 responses 协议
 *
 * 关键约束与对策：
 *  1. Codex 只认 responses 协议，而用户的上游多是 chat/completions
 *     → 一律指向本地网关，由网关把 responses 翻译成 chat（见 gateway/server）
 *  2. config.toml 只有单个 `model`，但要支持多模型切换
 *     → 为每个模型额外生成 profile 文件 ~/.codex/<alias>.config.toml，
 *       用 `codex --profile <alias>` 选择
 *  3. 用户的 config.toml 里有 mcp_servers / notify 等大量配置
 *     → 只定点改 model / model_provider 与 providers 表，其余原样保留
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelEntry } from '../types.js';
import type { ApplyResult, TargetAdapter, TargetInfo } from './types.js';
import { expandPath, writeFileAtomicSafe } from './types.js';
import { readTopLevel, setTopLevel, setTable } from '../toml.js';

/** Codex 配置根（$CODEX_HOME 优先） */
export function codexHome(): string {
  const fromEnv = process.env.CODEX_HOME?.trim();
  if (fromEnv) return path.resolve(expandPath(fromEnv));
  return path.join(os.homedir(), '.codex');
}

/** 网关 provider 在 Codex 里的 id */
export const CODEX_PROVIDER_ID = 'wb-switch';

export class CodexTarget implements TargetAdapter {
  readonly id = 'codex';
  readonly name = 'Codex';
  readonly format = 'toml' as const;
  readonly protocol = 'responses' as const;

  /** 网关地址（由上层注入，默认本机 7533） */
  constructor(
    private gatewayBase = 'http://127.0.0.1:7533/v1',
    private overrideHome?: string,
  ) {}

  home(): string {
    return this.overrideHome ? path.resolve(this.overrideHome) : codexHome();
  }

  configPath(): string {
    return path.join(this.home(), 'config.toml');
  }

  installed(): boolean {
    return fs.existsSync(this.home());
  }

  /** Codex 的模型是在 provider 后面，读回来只有「当前选中的那一个」 */
  readModels(): ModelEntry[] | null {
    const file = this.configPath();
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    const top = readTopLevel(text);
    const model = typeof top.model === 'string' ? top.model : '';
    if (!model) return [];
    // provider 定义了 base_url / env_key，模型条目从这里还原
    const providers = text.match(/^\[model_providers\.([^\]]+)\]/gm) ?? [];
    const providerId = typeof top.model_provider === 'string' ? top.model_provider : '';
    const idx = providers.findIndex((p) => p.includes(`.${providerId}]`));
    const baseUrl = idx >= 0 ? extractProviderValue(text, providerId, 'base_url') : '';
    return [
      {
        id: model,
        name: model,
        vendor: 'Custom',
        url: baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/chat/completions` : '',
        apiKey: '',
        supportsToolCall: true,
      },
    ];
  }

  /**
   * 写入 Codex 配置。
   *  - 第一个模型作为 config.toml 的默认 model
   *  - 每个模型都生成 profile 文件，便于 `codex --profile <alias>` 切换
   */
  writeModels(models: ModelEntry[], _options: { merge?: boolean } = {}): ApplyResult {
    if (!models.length) throw new Error('没有可写入的模型。');
    const file = this.configPath();
    const notes: string[] = [];

    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

    // 1) provider 指向本地网关（responses 协议）
    text = setTable(text, `model_providers.${CODEX_PROVIDER_ID}`, {
      name: 'wb-switch gateway',
      base_url: this.gatewayBase,
      wire_api: 'responses',
      // 网关本身不校验鉴权；内联一个占位 token 免去用户配环境变量
      experimental_bearer_token: 'wb-switch-local',
    });

    // 2) 默认模型 = 第一个
    const primary = models[0]!;
    text = setTopLevel(text, 'model', primary.id);
    text = setTopLevel(text, 'model_provider', CODEX_PROVIDER_ID);

    writeFileAtomicSafe(file, text);
    notes.push(`默认模型 ${primary.id}`);

    // 3) 为每个模型生成 profile（多模型切换）
    const profilesDir = this.home();
    const written: string[] = [];
    for (const m of models) {
      const pFile = path.join(profilesDir, `${safeProfileName(m.id)}.config.toml`);
      const pBody = [
        `model = ${JSON.stringify(m.id)}`,
        `model_provider = ${JSON.stringify(CODEX_PROVIDER_ID)}`,
        '',
        `[model_providers.${CODEX_PROVIDER_ID}]`,
        `name = "wb-switch gateway"`,
        `base_url = ${JSON.stringify(this.gatewayBase)}`,
        `wire_api = "responses"`,
        `experimental_bearer_token = "wb-switch-local"`,
        '',
      ].join('\n');
      writeFileAtomicSafe(pFile, pBody);
      written.push(path.basename(pFile, '.config.toml'));
    }
    if (written.length > 1) {
      notes.push(`已生成 ${written.length} 个 profile：codex --profile <名称> 切换`);
    }

    return { file, modelCount: models.length, notes };
  }

  describe(): TargetInfo {
    return {
      id: this.id,
      name: this.name,
      configPath: this.configPath(),
      format: this.format,
      protocol: this.protocol,
      installed: this.installed(),
      hint: 'OpenAI Codex CLI，config.toml 需 wire_api=responses，经本地网关转换',
    };
  }
}

/** 从 provider 段落里取一个值 */
function extractProviderValue(text: string, providerId: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const header = `[model_providers.${providerId}]`;
  let inSection = false;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      inSection = line.trim() === header;
      continue;
    }
    if (inSection) {
      const m = re.exec(line);
      if (m) return m[1]!;
    }
  }
  return '';
}

/** Codex profile 文件名安全化（不能带路径分隔符） */
function safeProfileName(id: string): string {
  return id.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, '-');
}
