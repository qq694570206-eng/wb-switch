/**
 * 模型能力字段与自动识别的回归测试（不依赖 Electron / 网络）。
 *
 * 覆盖：
 *  - ModelView ↔ ModelEntry round-trip：
 *    onlyReasoning / maxInputTokens / maxOutputTokens / reasoning.supportedEfforts
 *    与未知字段（如 ccSwitchProviderId）的保留
 *  - detectAbilities：已知模型 / 命名规则 / 边界（gpt-4o 不误判推理）
 *  - composeModelsFromRemote：autoDetect 开 / 关 两条路径
 *
 * 用法：node tests/abilities.mjs
 */

import { toModelView, fromModelView, composeModelsFromRemote } from '../dist/gui/service.js';
import { detectAbilities } from '../dist/gui/abilities.js';

let pass = 0;
const fails = [];

function check(label, actual, expected) {
  if (actual === expected) {
    pass++;
    return;
  }
  fails.push(`${label}\n    期望: ${expected}\n    实际: ${actual}`);
}

function ok(label, cond) {
  if (cond) pass++;
  else fails.push(label);
}

// ───────────────────────── 1. round-trip ─────────────────────────

const userEntry = {
  id: 'auto',
  name: 'auto',
  vendor: 'Custom',
  url: 'https://t-iface.gaodunwangxiao.com',
  apiKey: '',
  supportsToolCall: true,
  supportsImages: true,
  supportsReasoning: true,
  useCustomProtocol: true,
  onlyReasoning: true,
  maxInputTokens: 32000,
  maxOutputTokens: 32000,
  reasoning: { supportedEfforts: ['low', 'xhigh', 'max', 'medium', 'high'] },
  ccSwitchProviderId: '1',
};
const v = toModelView(userEntry);
check('view.onlyReasoning', v.onlyReasoning, true);
check('view.maxInputTokens', v.maxInputTokens, 32000);
check('view.maxOutputTokens', v.maxOutputTokens, 32000);
check('view.reasoningEfforts.length', v.reasoningEfforts?.length, 5);
check('view.reasoningEfforts[1]', v.reasoningEfforts?.[1], 'xhigh');
check('view.extra 保留 ccSwitchProviderId', v.extra?.ccSwitchProviderId, '1');

const back = fromModelView(v);
check('round-trip onlyReasoning', back.onlyReasoning, true);
check('round-trip maxInputTokens', back.maxInputTokens, 32000);
check('round-trip maxOutputTokens', back.maxOutputTokens, 32000);
check('round-trip efforts 顺序保持', JSON.stringify(back.reasoning?.supportedEfforts), JSON.stringify(['low', 'xhigh', 'max', 'medium', 'high']));
check('round-trip ccSwitchProviderId', back.ccSwitchProviderId, '1');
check('round-trip supportsImages', back.supportsImages, true);

// ── 空字段不写入 ──
const minimal = toModelView({ id: 'x', url: 'https://x/v1', apiKey: 'k' });
const minimalBack = fromModelView(minimal);
ok('无 onlyReasoning 时键不存在', !('onlyReasoning' in minimalBack));
ok('无 maxInputTokens 时键不存在', !('maxInputTokens' in minimalBack));
ok('无 reasoning 时键不存在', !('reasoning' in minimalBack));

// ── reasoning 里除 supportedEfforts 外的字段保留 ──
const withRest = toModelView({
  id: 'y',
  url: 'https://y/v1',
  apiKey: 'k',
  reasoning: { supportedEfforts: ['low', 'high'], budget: 'auto' },
});
check('reasoning.rest 保留 budget', withRest.extra?.reasoningRest?.budget, 'auto');
const withRestBack = fromModelView(withRest);
check('回写时 budget 仍在', withRestBack.reasoning?.budget, 'auto');

// ───────────────────────── 2. detectAbilities ─────────────────────────

// 已知模型
check('o3-mini 推理', detectAbilities('o3-mini').supportsReasoning, true);
check('gpt-4o 图像', detectAbilities('gpt-4o').supportsImages, true);
check('gpt-4o 不误判推理', detectAbilities('gpt-4o').supportsReasoning, false);
check('gpt-4o-mini 不误判推理', detectAbilities('gpt-4o-mini').supportsReasoning, false);
check('o1-mini 仅推理', detectAbilities('o1-mini').onlyReasoning, true);
check('deepseek-reasoner 仅推理', detectAbilities('deepseek-reasoner').onlyReasoning, true);
check('deepseek-r1 仅推理', detectAbilities('deepseek-r1').onlyReasoning, true);
check('gemini-2.5-flash 图像', detectAbilities('gemini-2.5-flash').supportsImages, true);
check('gemini-2.5-flash 有档位', detectAbilities('gemini-2.5-flash').reasoningEfforts?.includes('none'), true);
check('claude-sonnet-4-5 带日期也命中', detectAbilities('claude-sonnet-4-5-20250929').supportsReasoning, true);

// 命名规则
check('*-thinking 推理', detectAbilities('kimi-k2-thinking').supportsReasoning, true);
check('*-vl- 图像', detectAbilities('qwen3-vl-plus').supportsImages, true);
check('glm-4.5v 图像', detectAbilities('glm-4.5v').supportsImages, true);

// 兜底：未知模型默认工具调用开
const unknown = detectAbilities('totally-unknown-model');
check('未知模型工具调用默认开', unknown.supportsToolCall, true);
check('未知模型推理默认关', unknown.supportsReasoning, false);
check('未知模型无档位', unknown.reasoningEfforts, null);

// 推理关则 onlyReasoning 强制关
const noReason = detectAbilities('gpt-3.5-turbo');
check('无推理则无 onlyReasoning', noReason.onlyReasoning, false);

// ───────────────────────── 3. composeModelsFromRemote ─────────────────────────

const auto = composeModelsFromRemote({ url: 'https://x/v1', apiKey: 'sk-1', ids: ['o3-mini', 'gpt-4o', 'deepseek-r1'] });
const byId = Object.fromEntries(auto.map((m) => [m.id, m]));
check('auto: o3-mini 推理', byId['o3-mini'].supportsReasoning, true);
check('auto: o3-mini 有 efforts', Array.isArray(byId['o3-mini'].reasoningEfforts), true);
check('auto: gpt-4o 图像', byId['gpt-4o'].supportsImages, true);
check('auto: deepseek-r1 仅推理', byId['deepseek-r1'].onlyReasoning, true);
// 能落到 ModelEntry（写盘字段真实存在）
const r1 = fromModelView(byId['deepseek-r1']);
check('auto 落盘 reasoning.supportedEfforts', Array.isArray(r1.reasoning?.supportedEfforts), true);

const manual = composeModelsFromRemote({
  url: 'https://x/v1',
  apiKey: 'sk-1',
  ids: ['foo'],
  flags: { supportsToolCall: true, supportsImages: true, supportsReasoning: false },
  autoDetect: false,
});
check('manual: 尊重手动 flags', manual[0].supportsImages, true);
check('manual: 不自动加 efforts', manual[0].reasoningEfforts, null);

// ───────────────────────── 结果 ─────────────────────────

console.log(`\nabilities: ${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ''}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
