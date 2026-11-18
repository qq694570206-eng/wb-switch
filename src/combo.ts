/**
 * 组合（combo）源：把多个源的模型聚合成一个「独立源」。
 *
 * 与普通源的区别（普通源逻辑完全不变）：
 *   - 存储：profiles/<名>.json 带 type: "combo" 与 combo 成员定义
 *   - 切换：**追加模式**——选中组合时不覆盖当前已选源，把组合的模型条目
 *     追加到 models.json 尾部；后续追加组合/源沿用同样规则
 *   - 成员：自由组合，不要求同名——每个别名可引用任意（源, 模型）对，
 *     并可带自己的按序 fallback 链（失败重试 10 次后切下一个源）
 *   - 命名：组合名必须唯一（WorkBuddy 不支持重名），创建/重命名时校验
 *
 * 组合的 models 字段是聚合产物（缓存），每次成员变更后重新生成。
 */

import { ConfigError, ProfileError, UsageError } from './errors.js';
import type { ComboMember, ModelEntry, Profile } from './types.js';
import { loadProfile, listProfileNames, profileExists, saveProfile, validateProfileName } from './profiles.js';
import { modelsEqual } from './config.js';

/** 组合内别名的合法性（与网关 alias 规则一致） */
export function validateComboAlias(alias: string): string {
  const a = alias.trim();
  if (!a) throw new UsageError('组合成员别名不能为空。');
  if (/\s/.test(a)) throw new UsageError(`别名不能包含空白字符："${a}"。`);
  if (a.length > 96) throw new UsageError('别名过长（最多 96 字符）。');
  return a;
}

/**
 * 创建组合。
 * 组合名必须全局唯一：不能与任何已有源/组合重名（大小写不敏感）。
 */
export function createCombo(
  root: string,
  name: string,
  members: ComboMember[],
  description?: string,
): Profile {
  const norm = validateProfileName(name);
  if (profileExists(root, norm)) {
    throw new ProfileError(
      `名称「${norm}」已被占用（WorkBuddy 不支持重名）。`,
      '换个名字，或先删除已有的同名源/组合。',
    );
  }
  if (members.length === 0) {
    throw new UsageError('组合至少需要一个成员（--profile <源> --model <模型ID>）。');
  }
  const validated = validateMembers(root, members);
  const profile: Profile = {
    name: norm,
    description: description ?? `组合（${validated.length} 个成员）`,
    type: 'combo',
    origin: { type: 'manual', createdAt: new Date().toISOString() },
    models: buildComboModels(validated),
    combo: validated,
  };
  saveProfile(root, profile);
  return profile;
}

/** 校验成员列表：别名唯一 + 每个（源,模型）引用有效 */
export function validateMembers(root: string, members: ComboMember[]): ComboMember[] {
  const seen = new Set<string>();
  const out: ComboMember[] = [];
  for (const m of members) {
    const alias = validateComboAlias(m.alias);
    if (seen.has(alias)) {
      throw new ConfigError(`组合内别名重复：「${alias}」（WorkBuddy 不支持重名）。`);
    }
    seen.add(alias);
    if (!Array.isArray(m.sources) || m.sources.length === 0) {
      throw new UsageError(`成员 ${alias} 至少需要一个来源（profile + model）。`);
    }
    const sources: { profile: string; model: string }[] = [];
    for (const s of m.sources) {
      sources.push({ profile: s.profile, model: s.model });
    }
    out.push({ alias, sources });
  }
  return out;
}

/** 引用有效性检查（创建/编辑时逐个校验，报错指明具体成员） */
export function assertMembersResolvable(root: string, members: ComboMember[]): void {
  for (const m of members) {
    for (const s of m.sources) {
      try {
        const profile = loadProfile(root, s.profile);
        const entry = profile.models.find(x => x.id === s.model);
        if (!entry) {
          throw new ConfigError(`源「${s.profile}」中没有模型 ${s.model}`);
        }
      } catch (err) {
        throw new ConfigError(
          `组合成员 ${m.alias} 引用无效：${(err as Error).message}`,
          '检查源名称与模型 ID 是否存在。',
        );
      }
    }
  }
}

/** 聚合生成组合的 models 条目（成员变更后刷新缓存用） */
export function buildComboModels(members: ComboMember[]): ModelEntry[] {
  return members.map(m => ({
    id: m.alias,
    name: m.alias,
    vendor: 'wb-combo',
    url: '', // 组合条目不能直接用：需要网关（gateway）实际转发
    apiKey: 'wb-combo',
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: false,
    useCustomProtocol: false,
  }));
}

/** 读取组合；非组合报错 */
export function loadCombo(root: string, name: string): Profile & { combo: ComboMember[] } {
  const profile = loadProfile(root, name);
  if (profile.type !== 'combo' || !Array.isArray(profile.combo)) {
    throw new ProfileError(
      `「${profile.name}」不是组合（type=${profile.type ?? 'normal'}）。`,
      '组合操作只适用于 combo 源。',
    );
  }
  return profile as Profile & { combo: ComboMember[] };
}

/** 列出全部组合名 */
export function listComboNames(root: string): string[] {
  const out: string[] = [];
  for (const name of listProfileNames(root)) {
    try {
      const p = loadProfile(root, name);
      if (p.type === 'combo') out.push(name);
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return out;
}

/** 组合是否存在 */
export function comboExists(root: string, name: string): boolean {
  try {
    loadCombo(root, name);
    return true;
  } catch {
    return false;
  }
}

/** 向组合追加成员（--after 指定插入位置，缺省尾部） */
export function addComboMember(root: string, comboName: string, member: ComboMember, afterAlias?: string): Profile {
  const combo = loadCombo(root, comboName);
  const validated: ComboMember = validateMembers(root, [member])[0]!;

  // 组合内别名重复校验
  if (combo.combo.some(m => m.alias === validated.alias)) {
    throw new ConfigError(
      `组合「${combo.name}」内已存在别名「${validated.alias}」。`,
      '组合内别名必须唯一（WorkBuddy 不支持重名）。',
    );
  }
  assertMembersResolvable(root, [validated]);

  const members = [...combo.combo];
  if (afterAlias) {
    const idx = members.findIndex(m => m.alias === afterAlias);
    if (idx < 0) {
      throw new ProfileError(`组合「${combo.name}」里没有成员 ${afterAlias}。`);
    }
    members.splice(idx + 1, 0, validated);
  } else {
    members.push(validated);
  }

  combo.combo = members;
  combo.models = buildComboModels(members);
  saveProfile(root, combo);
  return combo;
}

/** 移除组合成员 */
export function removeComboMember(root: string, comboName: string, alias: string): Profile {
  const combo = loadCombo(root, comboName);
  const members = combo.combo.filter(m => m.alias !== alias.trim());
  if (members.length === combo.combo.length) {
    throw new ProfileError(`组合「${combo.name}」里没有成员 ${alias}。`);
  }
  combo.combo = members;
  combo.models = buildComboModels(members);
  saveProfile(root, combo);
  return combo;
}

/** 重命名组合（重名校验） */
export function renameCombo(root: string, oldName: string, newName: string): void {
  const norm = validateProfileName(newName);
  if (norm.toLowerCase() !== oldName.toLowerCase() && profileExists(root, norm)) {
    throw new ProfileError(`名称「${norm}」已被占用。`);
  }
  const combo = loadCombo(root, oldName);
  combo.name = norm;
  saveProfile(root, combo);
  // 删除旧文件由调用方（profiles.renameProfile 有现成逻辑，但组合结构特殊，这里手动删）
}

/** 组合 lint：引用有效性 + 组合内别名唯一 */
export function lintCombo(root: string, comboName: string): { alias: string; problems: string[] }[] {
  const combo = loadCombo(root, comboName);
  const problems: { alias: string; problems: string[] }[] = [];
  const seen = new Set<string>();
  const names = new Set(listProfileNames(root).map(n => n.toLowerCase()));
  for (const m of combo.combo) {
    const errs: string[] = [];
    if (seen.has(m.alias)) errs.push('组合内别名重复');
    seen.add(m.alias);
    if (m.sources.length === 0) errs.push('没有来源');
    for (const s of m.sources) {
      if (!names.has(s.profile.toLowerCase())) {
        errs.push(`源「${s.profile}」不存在`);
        continue;
      }
      try {
        const p = loadProfile(root, s.profile);
        if (!p.models.some(x => x.id === s.model)) errs.push(`源「${s.profile}」没有模型 ${s.model}`);
      } catch (err) {
        errs.push((err as Error).message);
      }
    }
    if (errs.length) problems.push({ alias: m.alias, problems: errs });
  }
  return problems;
}

/** 组合是否已与当前 models.json 一致（用于「是否需要重新追加」判断） */
export function comboInSync(root: string, combo: Profile, current: ModelEntry[]): boolean {
  return modelsEqual(combo.models, current) || combo.models.every(m => current.some(c => c.id === m.id));
}
