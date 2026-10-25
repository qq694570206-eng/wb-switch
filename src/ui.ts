/**
 * 终端 UI：颜色、表格、确认框、方向键选择器。
 *
 * 不引入任何第三方依赖，全部基于 Node 内置 readline 实现，
 * 保证在 Windows（PowerShell / cmd / Windows Terminal / Git Bash）下可用。
 */

import readline from 'node:readline';
import { EnvError } from './errors.js';

// ─────────────────────────── 颜色 ───────────────────────────

const argvNoColor = process.argv.includes('--no-color');
const forceColor = process.env.FORCE_COLOR === '1' || process.env.CLI_FORCE_COLOR === '1';
const noColorEnv = process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb';

export const useColor =
  !argvNoColor && (forceColor || (!noColorEnv && Boolean(process.stdout.isTTY)));

const wrap = (open: number, close: number) => (s: string) =>
  useColor ? `\u001b[${open}m${s}\u001b[${close}m` : s;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  inverse: wrap(7, 27),
};

/** 依据终端能力选择符号集 */
const asciiMode = process.argv.includes('--ascii') || process.env.WB_ASCII === '1';
export const sym = asciiMode
  ? { active: '*', inactive: ' ', cursor: '>', ok: 'OK', fail: 'x', bullet: '-', arrow: '->' }
  : { active: '●', inactive: '○', cursor: '❯', ok: '✓', fail: '✗', bullet: '•', arrow: '→' };

// ─────────────────────────── 宽度计算 ───────────────────────────

/** 判断是否为全角字符（CJK 等），用于对齐 */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 去掉 ANSI 转义序列后计算显示宽度 */
export function displayWidth(s: string): number {
  const plain = s.replace(/\u001b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function padEndW(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

function padStartW(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

// ─────────────────────────── 表格 ───────────────────────────

export interface Column<T> {
  header: string;
  /** 单元格内容（可含颜色） */
  cell: (row: T, index: number) => string;
  /** 右对齐 */
  align?: 'left' | 'right';
  /** 最大显示宽度，超出截断 */
  maxWidth?: number;
}

function truncate(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  const plain = s;
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + (asciiMode ? '~' : '…');
}

/** 渲染表格 */
export function renderTable<T>(rows: T[], columns: Column<T>[], opts: { gap?: number } = {}): string {
  const gap = opts.gap ?? 2;
  const widths = columns.map((col) => {
    const max = col.maxWidth ?? 40;
    let w = displayWidth(col.header);
    rows.forEach((row, i) => {
      const len = displayWidth(col.cell(row, i));
      w = Math.max(w, Math.min(len, max));
    });
    return w;
  });

  const line = (cells: string[], forceAlign?: 'left' | 'right') =>
    cells
      .map((cell, i) => {
        const col = columns[i]!;
        const max = col.maxWidth ?? 40;
        const t = displayWidth(cell) > max ? truncate(cell, max) : cell;
        const align = forceAlign ?? col.align;
        return align === 'right' ? padStartW(t, widths[i]!) : padEndW(t, widths[i]!);
      })
      .join(' '.repeat(gap))
      .replace(/\s+$/, '');

  const header = line(columns.map((col) => c.dim(col.header)));
  const body = rows.map((row, i) => line(columns.map((col) => col.cell(row, i))));
  return [header, ...body].join('\n');
}

// ─────────────────────────── 基础输入 ───────────────────────────

export function isInteractive(): boolean {
  // WB_FORCE_TTY=1 用于自动化测试或特殊终端（如某些 CI 的伪终端）强制启用交互
  if (process.env.WB_FORCE_TTY === '1') return true;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// ── 输入实现 ──
// 真终端：使用 readline.question 逐行提问（带行内编辑与回显）
// 管道/重定向：把所有行读入队列后按需取用。原因：readline 在非终端模式下
// 会一次性把整个缓冲拆成多行事件，若只挂一个 question，其余行会被丢弃，
// 导致多步问答在第二步卡死。

let rlInstance: readline.Interface | null = null;
const lineQueue: string[] = [];
let lineWaiter: { resolve: (v: string) => void; reject: (e: Error) => void } | null = null;
let lineReaderReady = false;
let inputEnded = false;

function startLineReader(): void {
  if (lineReaderReady) return;
  lineReaderReady = true;
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (lineWaiter) {
      const w = lineWaiter;
      lineWaiter = null;
      w.resolve(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on('close', () => {
    inputEnded = true;
    if (lineWaiter) {
      const w = lineWaiter;
      lineWaiter = null;
      w.reject(new EnvError('输入已结束（EOF），操作已取消。'));
    }
  });
}

function getRl(): readline.Interface {
  if (!rlInstance) {
    rlInstance = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rlInstance.on('close', () => {
      rlInstance = null;
    });
  }
  return rlInstance;
}

/** 关闭交互会话（选择器接管 stdin 前调用） */
export function closePrompt(): void {
  if (rlInstance) {
    const rl = rlInstance;
    rlInstance = null;
    try {
      rl.close();
    } catch {
      /* ignore */
    }
  }
}

function ask(question: string): Promise<string> {
  process.stdout.write(question);

  if (!process.stdin.isTTY) {
    // 管道输入模式：从队列取行
    startLineReader();
    const next = lineQueue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (inputEnded) return Promise.reject(new EnvError('输入已结束（EOF），操作已取消。'));
    return new Promise<string>((resolve, reject) => {
      lineWaiter = { resolve, reject };
    }).then((line) => {
      process.stdout.write(line + '\n');
      return line;
    });
  }

  const rl = getRl();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const onClose = () => {
      if (settled) return;
      settled = true;
      reject(new EnvError('输入已结束（EOF），操作已取消。'));
    };
    rl.once('close', onClose);
    rl.once('SIGINT', () => {
      if (settled) return;
      settled = true;
      rl.removeListener('close', onClose);
      reject(new EnvError('已取消。'));
    });
    rl.question('', (answer) => {
      settled = true;
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

/** 单行文本输入 */
export async function promptText(
  question: string,
  opts: { default?: string; required?: boolean; validate?: (v: string) => string | null } = {},
): Promise<string> {
  if (!isInteractive()) {
    throw new EnvError(
      '当前不是交互式终端，无法进行问答输入。',
      '请改用带参数的命令，例如 wb-switch add <名称> --url <地址> --key <密钥>。',
    );
  }
  const suffix = opts.default ? c.gray(` (${opts.default})`) : '';

  for (;;) {
    const answer = await ask(`${question}${suffix} `);
    const value = answer.trim() || opts.default || '';
    if (opts.required && !value) {
      process.stdout.write(c.yellow('不能为空，请重新输入。\n'));
      continue;
    }
    if (opts.validate) {
      const err = opts.validate(value);
      if (err) {
        process.stdout.write(c.yellow(`${err}\n`));
        continue;
      }
    }
    return value;
  }
}

/** 是/否确认 */
export async function confirm(question: string, opts: { default?: boolean } = {}): Promise<boolean> {
  const def = opts.default ?? false;
  if (!isInteractive()) return def;
  const hint = def ? 'Y/n' : 'y/N';
  const answer = await promptText(`${question} ${c.gray(`[${hint}]`)}`);
  if (!answer) return def;
  return /^y(es)?$/i.test(answer);
}

/** 等待任意按键（双击 exe 运行时防止窗口一闪而过） */
export async function waitAnyKey(message = '\n按任意键退出…'): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stdout.write(c.gray(message));
  await new Promise<void>((resolve) => {
    const done = () => {
      process.stdin.removeListener('data', done);
      process.stdin.pause();
      process.stdout.write('\n');
      resolve();
    };
    process.stdin.resume();
    process.stdin.once('data', done);
    // 安全兜底：8 秒无操作自动退出，避免挂住
    setTimeout(done, 8000).unref?.();
  });
}

// ─────────────────────────── 选择器 ───────────────────────────

export interface PickerItem {
  /** 主标题 */
  label: string;
  /** 次要说明，显示在标题右侧 */
  detail?: string;
  /** 是否高亮为「当前项」 */
  marked?: boolean;
  /** 是否禁用 */
  disabled?: boolean;
}

export interface PickerOptions {
  title: string;
  /** 底部提示 */
  hint?: string;
  /** 初始选中项 */
  initialIndex?: number;
  /** 最多显示多少行 */
  maxRows?: number;
}

/**
 * 方向键选择器。返回选中下标；用户取消（Esc/q/Ctrl+C）返回 null。
 * 非交互终端直接抛 EnvError。
 */
export async function pick(items: PickerItem[], options: PickerOptions): Promise<number | null> {
  if (items.length === 0) return null;
  if (!isInteractive()) {
    throw new EnvError(
      '当前不是交互式终端，无法显示选择列表。',
      '请直接指定名称：wb-switch use <名称>；或先运行 wb-switch list 查看。',
    );
  }

  closePrompt();

  const stdin = process.stdin;
  const stdout = process.stdout;
  const rows = Math.max(3, (stdout.rows || 24) - 8);
  const maxRows = Math.min(options.maxRows ?? rows, rows, items.length);

  let index = Math.min(Math.max(options.initialIndex ?? 0, 0), items.length - 1);
  // 跳过禁用项
  const step = (dir: number) => {
    let next = index;
    for (let i = 0; i < items.length; i++) {
      next = (next + dir + items.length) % items.length;
      if (!items[next]?.disabled) break;
    }
    index = next;
  };
  while (items[index]?.disabled && index < items.length - 1) index++;

  let top = 0;
  const adjustWindow = () => {
    if (index < top) top = index;
    if (index >= top + maxRows) top = index - maxRows + 1;
    top = Math.max(0, Math.min(top, items.length - maxRows));
  };

  const buildLines = (): string[] => {
    const lines: string[] = [];
    lines.push(c.bold(options.title));
    lines.push(c.gray('─'.repeat(Math.min(displayWidth(options.title) + 8, 60))));
    adjustWindow();
    const visible = items.slice(top, top + maxRows);
    visible.forEach((item, i) => {
      const realIndex = top + i;
      const isCur = realIndex === index;
      const mark = item.marked ? c.green(sym.active) : c.gray(sym.inactive);
      const num = c.gray(String(realIndex + 1).padStart(2, ' '));
      const label = item.disabled ? c.gray(item.label) : item.label;
      const detail = item.detail ? c.gray(`  ${item.detail}`) : '';
      const body = `${mark} ${num}. ${label}${detail}`;
      lines.push(isCur ? c.cyan(`${sym.cursor} `) + c.bold(body) : `  ${body}`);
    });
    if (items.length > maxRows) {
      lines.push(c.gray(`  … 共 ${items.length} 项，当前 ${index + 1}/${items.length}`));
    }
    lines.push(
      c.gray(options.hint ?? `↑/↓ 选择   Enter 确认   q 取消   (1-${items.length} 快速跳转)`),
    );
    return lines;
  };

  let rendered = 0;
  const draw = () => {
    const lines = buildLines();
    if (rendered > 0) stdout.write(`\u001b[${rendered}A`);
    for (const line of lines) {
      stdout.write('\u001b[2K' + line + '\n');
    }
    // 若上次行数多于本次，清掉多余行
    if (rendered > lines.length) {
      for (let i = 0; i < rendered - lines.length; i++) stdout.write('\u001b[2K\n');
      stdout.write(`\u001b[${rendered - lines.length}A`);
    }
    rendered = lines.length;
  };

  const cleanup = () => {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\u001b[?25h'); // 显示光标
  };

  readline.emitKeypressEvents(stdin);
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  stdin.resume();
  stdout.write('\u001b[?25l'); // 隐藏光标

  return new Promise<number | null>((resolve, reject) => {
    let done = false;
    const finish = (value: number | null) => {
      if (done) return;
      done = true;
      stdin.removeListener('keypress', onKey);
      cleanup();
      // 清掉选择器区域，保持输出整洁
      if (rendered > 0) {
        stdout.write(`\u001b[${rendered}A`);
        for (let i = 0; i < rendered; i++) stdout.write('\u001b[2K\n');
        stdout.write(`\u001b[${rendered}A`);
      }
      resolve(value);
    };

    const onKey = (_str: string, key: readline.Key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') return finish(null);
      switch (key.name) {
        case 'up':
        case 'k':
          step(-1);
          return draw();
        case 'down':
        case 'j':
          step(1);
          return draw();
        case 'home':
          index = 0;
          return draw();
        case 'end':
          index = items.length - 1;
          return draw();
        case 'return':
        case 'enter':
          if (items[index]?.disabled) return;
          return finish(index);
        case 'escape':
        case 'q':
          return finish(null);
        default:
          break;
      }
      if (/^[0-9]$/.test(key.sequence ?? _str ?? '')) {
        // 支持多位数字跳转
        const digit = key.sequence ?? _str;
        const candidate = Number.parseInt(digit, 10);
        if (Number.isFinite(candidate) && candidate >= 1 && candidate <= items.length) {
          index = candidate - 1;
          draw();
        }
      }
    };

    stdin.on('keypress', onKey);
    draw();
    // 兜底：进程异常退出时恢复终端
    process.once('exit', () => {
      if (!done) {
        try {
          stdout.write('\u001b[?25h');
        } catch {
          /* ignore */
        }
      }
    });
    void reject;
  });
}

// ─────────────────────────── 输出helpers ───────────────────────────

export function ok(msg: string): void {
  process.stdout.write(`${c.green(sym.ok)} ${msg}\n`);
}

export function fail(msg: string): void {
  process.stderr.write(`${c.red(sym.fail)} ${msg}\n`);
}

export function warn(msg: string): void {
  process.stderr.write(`${c.yellow('!')} ${msg}\n`);
}

export function info(msg: string): void {
  process.stdout.write(`${c.blue('i')} ${msg}\n`);
}

export function heading(msg: string): void {
  process.stdout.write(`\n${c.bold(msg)}\n`);
}

export function blank(): void {
  process.stdout.write('\n');
}
