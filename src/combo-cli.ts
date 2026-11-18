/**
 * 组合命令组：wb-switch combo <sub> 与 wb-switch append。
 *
 *   combo create <名> --profile <源> --model <模型ID> [--profile2 ...] [--alias <别名>]
 *        创建组合（成员可后续 add）。alias 缺省 = 模型 ID。
 *   combo add <组合名> --profile <源> --model <模型ID> [--alias <别名>] [--after <成员别名>]
 *        向组合追加成员（可带自己的多源 fallback 链）
 *   combo rm-member <组合名> <别名>
 *   combo list / show <名> / lint [名]
 *   combo remove <名>
 *   use <组合名>        （主 CLI 分流：组合走追加模式）
 *   append <源名...>    追加普通源（--on-conflict error|skip|suffix）
 */

import path from 'node:path';
import { c, fail, heading, ok, warn } from './ui.js';
import type { ComboMember } from './types.js';
import {
  addComboMember,
  assertMembersResolvable,
  createCombo,
  lintCombo,
  listComboNames,
  loadCombo,
  removeComboMember,
} from './combo.js';
import { listProfileNames, deleteProfile, profileExists } from './profiles.js';
import { mergeComboIntoRoutes, removeAliasesFromRoutes } from './gateway/routes.js';
import { appendProfile, useCombo, type ConflictPolicy } from './appender.js';
import type { Args } from './gateway/cli-bridge.js';
import { resolveConfigRoot } from './paths.js';

const has = (a: Args, k: string) => a.flags.has(k) && a.flags.get(k) !== false;
const str = (a: Args, k: string): string | undefined => {
  const v = a.flags.get(k);
  return typeof v === 'string' ? v : undefined;
};

function jsonOut(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** 解析一组成员（create/add 共用）：--alias 可选，fallback 链同 gateway route add */
export function parseMembersFromArgs(args: Args): ComboMember[] {
  const groups: { profile?: string; model?: string }[] = [
    { profile: str(args, 'profile'), model: str(args, 'model') },
  ];
  for (let i = 2; i <= 5; i++) {
    const p = str(args, `profile${i}`);
    const m = str(args, `model${i}`);
    if (p || m) groups.push({ profile: p, model: m });
  }
  const alias = str(args, 'alias');
  const sources: { profile: string; model: string }[] = [];
  for (const g of groups) {
    if (!g.profile || !g.model) {
      fail(`来源需要成对提供 --profile <源> 与 --model <模型ID>（收到 profile=${g.profile ?? '无'} model=${g.model ?? '无'}）。`);
      throw new Error('usage');
    }
    sources.push({ profile: g.profile, model: g.model });
  }
  // alias 缺省取第一个模型 ID
  return [{ alias: alias ?? sources[0]!.model, sources }];
}

export function cmdCombo(args: Args): number {
  const sub = args.positional[1];
  const root = args.configDir ? path.resolve(args.configDir) : resolveConfigRoot();

  switch (sub) {
    case 'create':
      return cmdCreate(args, root);
    case 'add':
    case 'add-member':
      return cmdAddMember(args, root);
    case 'rm-member':
    case 'remove-member':
      return cmdRmMember(args, root);
    case 'list':
    case 'ls':
      return cmdList(args, root);
    case 'show':
      return cmdShow(args, root);
    case 'lint':
      return cmdLint(args, root);
    case 'remove':
    case 'rm':
      return cmdRemove(args, root);
    default:
      fail(`未知 combo 子命令：${sub ?? '(空)'}`);
      process.stderr.write('可用：create add rm-member list show lint remove\n');
      return 2;
  }
}

function cmdCreate(args: Args, root: string): number {
  const name = args.positional[2];
  if (!name) {
    fail('用法：wb-switch combo create <组合名> --profile <源> --model <模型ID> [--profile2 <源> --model2 <模型ID>] [--alias <别名>]');
    return 2;
  }

  let members: ComboMember[];
  try {
    members = parseMembersFromArgs(args);
  } catch {
    return 2;
  }

  // 引用有效性预检
  try {
    assertMembersResolvable(root, members);
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }

  try {
    const combo = createCombo(root, name, members, str(args, 'description') ?? str(args, 'desc'));
    const comboMembers = combo.combo ?? [];
    // 组合成员同步进网关路由表（fallback 链）
    mergeComboIntoRoutes(root, combo);
    if (has(args, 'json')) {
      jsonOut({ created: combo.name, members: comboMembers });
      return 0;
    }
    ok(`已创建组合 ${c.bold(c.cyan(combo.name))}（${comboMembers.length} 个成员）。`);
    for (const m of comboMembers) {
      process.stdout.write(`  ${c.bold(m.alias)} ← ${m.sources.map(s => `${s.profile}/${s.model}`).join(c.gray(' → '))}\n`);
    }
    process.stdout.write(`\n${c.gray('选中组合（追加模式，不覆盖当前源）')} wb-switch use ${combo.name}\n`);
    return 0;
  } catch (err) {
    fail((err as Error).message);
    return err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 1;
  }
}

function cmdAddMember(args: Args, root: string): number {
  const comboName = args.positional[2];
  if (!comboName) {
    fail('用法：wb-switch combo add <组合名> --profile <源> --model <模型ID> [--alias <别名>] [--after <成员别名>]');
    return 2;
  }
  let members: ComboMember[];
  try {
    members = parseMembersFromArgs(args);
  } catch {
    return 2;
  }
  try {
    const combo = addComboMember(root, comboName, members[0]!, str(args, 'after'));
    const comboMembers = combo.combo ?? [];
    mergeComboIntoRoutes(root, combo);
    if (has(args, 'json')) {
      jsonOut({ updated: combo.name, members: comboMembers });
      return 0;
    }
    ok(`已向组合 ${c.bold(c.cyan(combo.name))} 追加成员 ${c.bold(members[0]!.alias)}（共 ${comboMembers.length} 个）。`);
    return 0;
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
}

function cmdRmMember(args: Args, root: string): number {
  const comboName = args.positional[2];
  const alias = args.positional[3];
  if (!comboName || !alias) {
    fail('用法：wb-switch combo rm-member <组合名> <别名>');
    return 2;
  }
  try {
    const combo = removeComboMember(root, comboName, alias);
    removeAliasesFromRoutes(root, [alias]);
    ok(`已从组合 ${combo.name} 移除成员 ${alias}（剩 ${combo.combo?.length ?? 0} 个）。`);
    return 0;
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
}

function cmdList(args: Args, root: string): number {
  const names = listComboNames(root);
  if (names.length === 0) {
    warn('还没有组合。');
    process.stdout.write(`  ${c.gray('创建：')} wb-switch combo create <名> --profile <源> --model <模型ID>\n`);
    return 0;
  }
  if (has(args, 'json')) {
    const out = names.map(n => {
      const combo = loadCombo(root, n);
      return { name: n, members: combo.combo.map(m => ({ alias: m.alias, sources: m.sources })) };
    });
    jsonOut(out);
    return 0;
  }
  heading(`组合（${names.length} 个）`);
  for (const n of names) {
    try {
      const combo = loadCombo(root, n);
      process.stdout.write(`  ${c.bold(c.cyan(n))} ${c.gray(`· ${combo.combo.length} 成员 · ${combo.description ?? ''}`)}\n`);
      for (const m of combo.combo) {
        process.stdout.write(`    ${m.alias} ← ${m.sources.map(s => `${s.profile}/${s.model}`).join(c.gray(' → '))}\n`);
      }
    } catch {
      process.stdout.write(`  ${c.red(n)} ${c.gray('(读取失败)')}\n`);
    }
  }
  return 0;
}

function cmdShow(args: Args, root: string): number {
  const name = args.positional[2];
  if (!name) {
    fail('用法：wb-switch combo show <组合名>');
    return 2;
  }
  try {
    const combo = loadCombo(root, name);
    if (has(args, 'json')) {
      jsonOut(combo);
      return 0;
    }
    heading(`组合 ${combo.name}`);
    process.stdout.write(`  ${c.gray('描述')} ${combo.description ?? '-'}\n`);
    for (const m of combo.combo) {
      process.stdout.write(`  ${c.bold(m.alias)}\n`);
      m.sources.forEach((s, i) => {
        const mark = i === 0 ? c.green('①') : c.gray(String(i + 1));
        process.stdout.write(`    ${mark} ${s.profile}${c.gray('/')}${s.model}\n`);
      });
    }
    return 0;
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
}

function cmdLint(args: Args, root: string): number {
  const name = args.positional[2];
  const names = name ? [name] : listComboNames(root);
  if (names.length === 0) {
    warn('还没有组合。');
    return 0;
  }
  let totalProblems = 0;
  for (const n of names) {
    let problems: { alias: string; problems: string[] }[] = [];
    try {
      problems = lintCombo(root, n);
    } catch (err) {
      fail(`组合 ${n}：${(err as Error).message}`);
      totalProblems++;
      continue;
    }
    if (problems.length === 0) {
      if (!has(args, 'json')) ok(`组合 ${n} 全部有效。`);
    } else {
      totalProblems += problems.length;
      if (has(args, 'json')) continue;
      warn(`组合 ${n} 有 ${problems.length} 个问题：`);
      for (const p of problems) {
        process.stdout.write(`  ${c.red('!')} ${p.alias}\n`);
        for (const e of p.problems) process.stdout.write(`      ${c.gray(e)}\n`);
      }
    }
  }
  if (has(args, 'json')) {
    const out: Record<string, unknown> = {};
    for (const n of names) {
      try { out[n] = lintCombo(root, n); } catch { out[n] = [{ alias: '(error)', problems: ['读取失败'] }]; }
    }
    jsonOut({ ok: totalProblems === 0, problems: out });
  }
  return totalProblems === 0 ? 0 : 1;
}

function cmdRemove(args: Args, root: string): number {
  const name = args.positional[2];
  if (!name) {
    fail('用法：wb-switch combo remove <组合名>');
    return 2;
  }
  try {
    const combo = loadCombo(root, name);
    // 同步清理路由表里的组合成员 alias
    removeAliasesFromRoutes(root, combo.combo.map(m => m.alias));
    const kept = deleteProfile(root, combo.name, has(args, 'purge'));
    ok(`已删除组合 ${combo.name}${kept ? c.gray(`（副本：${path.basename(kept)}` + '）') : ''}。`);
    return 0;
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
}

// ─────────────────────────── append（追加源） ───────────────────────────

export function cmdAppend(args: Args): number {
  const names = args.positional.slice(1);
  if (names.length === 0) {
    fail('用法：wb-switch append <源名...> [--on-conflict error|skip|suffix]');
    return 2;
  }
  const root = args.configDir ? path.resolve(args.configDir) : resolveConfigRoot();
  const policyRaw = str(args, 'on-conflict') ?? str(args, 'conflict');
  const policy: ConflictPolicy = policyRaw === 'skip' || policyRaw === 'suffix' ? policyRaw : 'error';
  if (policyRaw && !['error', 'skip', 'suffix'].includes(policyRaw)) {
    fail(`--on-conflict 取值应为 error|skip|suffix，收到：${policyRaw}`);
    return 2;
  }

  // 预检：名称都得存在
  const known = new Set(listProfileNames(root).map(n => n.toLowerCase()));
  for (const n of names) {
    if (!known.has(n.toLowerCase())) {
      fail(`源不存在：${n}`);
      return 1;
    }
  }

  try {
    const results = names.map(n => {
      const r = n === names[0] && profileExists(root, n) && loadComboQuiet(root, n)
        ? useCombo(n, { configDir: root, onConflict: policy })
        : appendProfile(n, { configDir: root, onConflict: policy });
      return r;
    });
    if (has(args, 'json')) {
      jsonOut(results);
      return 0;
    }
    for (const r of results) {
      const bits = [`${r.added.length} 追加`];
      if (r.skipped.length) bits.push(`${r.skipped.length} 跳过`);
      if (r.renamed.length) bits.push(`${r.renamed.length} 改名`);
      ok(`「${r.name}」→ ${bits.join(' · ')}（models.json 共 ${r.total} 条）`);
      for (const rn of r.renamed) process.stdout.write(`    ${c.gray(rn.from + ' → ' + rn.to)}\n`);
    }
    const order = (results[0]?.appended ?? []).join(c.gray(' → '));
    process.stdout.write(`\n${c.gray('追加顺序')} ${order}\n`);
    return 0;
  } catch (err) {
    fail((err as Error).message);
    if ((err as { hint?: string }).hint) process.stderr.write(`  ${c.gray((err as { hint: string }).hint)}\n`);
    return 1;
  }
}

function loadComboQuiet(root: string, name: string): boolean {
  try {
    loadCombo(root, name);
    return true;
  } catch {
    return false;
  }
}
