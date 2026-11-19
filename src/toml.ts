/**
 * 轻量 TOML 定点编辑。
 *
 * 为什么不用 toml 库：
 *  - 本项目零运行时依赖（打包体积与安全考虑）
 *  - 用户的 config.toml 里可能有大量我们不懂的配置
 *    （mcp_servers / notify / profiles…），
 *    全量 parse→serialize 会丢注释、改顺序、破坏未知表
 *
 * 所以这里只做「定点改几行」：
 *  - 找到/替换顶层 `key = value`
 *  - 找到/替换 `[table]` 段落
 * 其余内容原样保留（含注释、空行、顺序）。
 */

/** 解析 TOML 的简单标量值（只覆盖配置文件里常见形态） */
export function parseTomlValue(raw: string): unknown {
  const v = raw.trim();
  if (!v) return '';
  // 字符串：'...' 或 "..."
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const quote = v[0];
    const body = v.slice(1, -1);
    if (quote === "'") return body; // 字面量字符串，不转义
    return body.replace(/\\(["\\ntr])/g, (_m, ch: string) => {
      switch (ch) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        default:
          return ch;
      }
    });
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^[[{]/.test(v)) {
    // 数组 / 内联表：先按 JSON 试，失败就原样返回字符串（够用即可）
    try {
      return JSON.parse(v.replace(/'/g, '"'));
    } catch {
      return v;
    }
  }
  const n = Number(v);
  if (Number.isFinite(n) && v !== '') return n;
  return v;
}

/** 把 JS 值序列化成 TOML 标量 */
export function serializeTomlValue(v: unknown): string {
  if (typeof v === 'string') {
    // 含特殊字符时用双引号并转义；否则用双引号（TOML 里最通用）
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(serializeTomlValue).join(', ')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return `{ ${entries.map(([k, val]) => `${k} = ${serializeTomlValue(val)}`).join(', ')} }`;
  }
  return '""';
}

/** 一段 [table] 的范围：从表头行到下一个表头（或文件末尾）之前 */
interface Section {
  /** 表名，如 model_providers.myrelay（顶层为 ''） */
  name: string;
  /** 表头行索引；顶层段落为 -1 */
  headerIdx: number;
  /** 内容行范围 [start, end) */
  start: number;
  end: number;
}

const TABLE_RE = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
const ARRAY_TABLE_RE = /^\s*\[\[([^\]]+)\]\]\s*(?:#.*)?$/;

/** 把文本切成行（保留行尾，方便原样拼回） */
function toLines(text: string): string[] {
  // 用 split 保留空行的换行符处理：统一按 \n 切，写回时用平台换行
  return text.split(/\r?\n/);
}

/** 扫描出所有 [table] 段落 */
export function scanSections(lines: string[]): Section[] {
  const headers: { name: string; idx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (ARRAY_TABLE_RE.test(line) || TABLE_RE.test(line)) {
      const m = ARRAY_TABLE_RE.exec(line) ?? TABLE_RE.exec(line);
      if (m) headers.push({ name: m[1]!.trim(), idx: i });
    }
  }
  const out: Section[] = [];
  // 顶层：第一个表头之前
  const firstHeader = headers.length ? headers[0]!.idx : lines.length;
  out.push({ name: '', headerIdx: -1, start: 0, end: firstHeader });
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const next = i + 1 < headers.length ? headers[i + 1]!.idx : lines.length;
    out.push({ name: h.name, headerIdx: h.idx, start: h.idx + 1, end: next });
  }
  return out;
}

/** 在一段范围内找 `key = value` 行，返回行索引与值 */
function findKeyInRange(
  lines: string[],
  start: number,
  end: number,
  key: string,
): { idx: number; value: unknown } | null {
  const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.*)$`);
  for (let i = start; i < end; i++) {
    const m = re.exec(lines[i]!);
    if (m) return { idx: i, value: parseTomlValue(m[1]!) };
  }
  return null;
}

/** 读顶层键（如 model / model_provider） */
export function readTopLevel(text: string): Record<string, unknown> {
  const lines = toLines(text);
  const sections = scanSections(lines);
  const top = sections.find((s) => s.name === '');
  if (!top) return {};
  const out: Record<string, unknown> = {};
  for (let i = top.start; i < top.end; i++) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(lines[i]!);
    if (m) out[m[1]!] = parseTomlValue(m[2]!);
  }
  return out;
}

/** 读某个 [table] 的键值 */
export function readTable(text: string, table: string): Record<string, unknown> {
  const lines = toLines(text);
  const sec = scanSections(lines).find((s) => s.name === table);
  if (!sec) return {};
  const out: Record<string, unknown> = {};
  for (let i = sec.start; i < sec.end; i++) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(lines[i]!);
    if (m) out[m[1]!] = parseTomlValue(m[2]!);
  }
  return out;
}

/** 列出所有表名 */
export function listTables(text: string): string[] {
  const lines = toLines(text);
  return scanSections(lines)
    .map((s) => s.name)
    .filter((n) => n !== '');
}

/**
 * 设置顶层键（已存在则原地替换，不存在则插到第一个表头之前）。
 * 返回值：新的完整文本
 */
export function setTopLevel(text: string, key: string, value: unknown): string {
  const lines = toLines(text);
  const sections = scanSections(lines);
  const top = sections.find((s) => s.name === '');
  const found = top ? findKeyInRange(lines, top.start, top.end, key) : null;
  const line = `${key} = ${serializeTomlValue(value)}`;

  if (found) {
    lines[found.idx] = line;
    return lines.join('\n');
  }
  // 插到顶层的最后一行非空行之后（保持顶部的键聚在一起）
  let insertAt = top ? top.end : lines.length;
  while (insertAt > 0 && !(lines[insertAt - 1] ?? '').trim()) insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

/**
 * 设置/替换整个 [table] 段落。
 * 已存在则整段替换；不存在则追加到文件末尾。
 */
export function setTable(text: string, table: string, values: Record<string, unknown>): string {
  const lines = toLines(text);
  const sections = scanSections(lines);
  const sec = sections.find((s) => s.name === table);
  const body = Object.entries(values).map(([k, v]) => `${k} = ${serializeTomlValue(v)}`);

  if (sec) {
    // 保留段落前后的空行，只替换内容
    const before = lines.slice(0, sec.headerIdx + 1);
    const after = lines.slice(sec.end);
    // 去掉 after 开头的多余空行，稍后统一补一个
    return [...before, ...body, '', ...after].join('\n').replace(/\n{3,}/g, '\n\n');
  }
  // 追加
  const trimmed = text.replace(/\s+$/, '');
  const sep = trimmed ? '\n\n' : '';
  return `${trimmed}${sep}[${table}]\n${body.join('\n')}\n`;
}

/** 删除一个 [table] 段落 */
export function removeTable(text: string, table: string): string {
  const lines = toLines(text);
  const sec = scanSections(lines).find((s) => s.name === table);
  if (!sec) return text;
  const before = lines.slice(0, sec.headerIdx);
  const after = lines.slice(sec.end);
  return [...before, ...after].join('\n').replace(/\n{3,}/g, '\n\n');
}

/** 生成一个最小的 TOML 文档（全新配置文件） */
export function buildMinimalToml(): string {
  return '';
}
