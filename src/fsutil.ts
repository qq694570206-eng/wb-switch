/**
 * 文件系统工具：安全的读写、原子替换、备份。
 *
 * Windows 注意事项：
 *  - rename 覆盖已存在文件在 Windows 上会失败（EPERM/EACCES），
 *    因此先写临时文件，再对目标做 unlink + rename，失败重试。
 *  - 保留原文件的换行风格与缩进风格（2 空格 / 4 空格 / Tab），避免无意义 diff。
 */

import fs from 'node:fs';
import path from 'node:path';
import { explainFsError, EnvError, ConfigError } from './errors.js';

export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw explainFsError(err, dir);
  }
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 读取文本，自动去 BOM，统一 LF 便于解析 */
export function readText(file: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new ConfigError(
        `找不到配置文件：${file}`,
        '请确认 WorkBuddy 已至少启动过一次，或用 --config-dir 指定正确目录。',
      );
    }
    throw explainFsError(err, file);
  }
  return raw.replace(/^\uFEFF/, '');
}

/** 读取并解析 JSON，报错带行号提示 */
export function readJson<T = unknown>(file: string): T {
  const text = readText(file);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `${file} 不是合法的 JSON：${msg}`,
      '请先在编辑器中修复该文件，或使用 wb-switch restore 从备份恢复。',
    );
  }
}

/** 探测已有文件的缩进风格（空格数）与是否以换行结尾 */
export interface FormatHint {
  indent: number;
  trailingNewline: boolean;
  eol: '\n' | '\r\n';
}

export function detectFormat(file: string): FormatHint {
  const defaultHint: FormatHint = { indent: 2, trailingNewline: true, eol: '\n' };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return defaultHint;
  }
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const m = text.match(/^[ \t]+/m);
  let indent = 2;
  if (m) {
    const lead = m[0];
    indent = lead.startsWith('\t') ? 1 : lead.length;
  }
  return { indent, trailingNewline: /\r?\n$/.test(text) || text.length === 0, eol };
}

/** 按格式序列化 JSON */
export function stringifyJson(value: unknown, fmt: FormatHint = { indent: 2, trailingNewline: true, eol: '\n' }): string {
  const indent = fmt.indent === 1 ? '\t' : fmt.indent;
  let text = JSON.stringify(value, null, indent as string | number);
  if (fmt.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (fmt.trailingNewline) text += fmt.eol;
  return text;
}

/**
 * 原子写入：临时文件 + rename，避免写一半导致配置损坏。
 * Windows 上 rename 前需先删目标文件，并在被占用时重试。
 */
export function writeFileAtomic(file: string, content: string): void {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8' });
  } catch (err) {
    throw explainFsError(err, tmp);
  }

  // 清理目标文件的只读属性（Windows 常见坑）
  try {
    if (exists(file)) {
      const st = fs.statSync(file);
      if ((st.mode & 0o200) === 0) fs.chmodSync(file, 0o666);
    }
  } catch {
    /* 忽略，后续 rename 会给出更明确的错误 */
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      // Windows: 目标存在时 rename 失败，先删除再重试
      try {
        if (exists(file)) fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    fs.unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  throw explainFsError(lastErr, file);
}

/** 时间戳，适合做文件名：20261024-224500 */
export function timestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** 备份一个文件，返回备份路径；源文件不存在返回 null */
export function backupFile(file: string, backupDir: string, label = 'models'): string | null {
  if (!exists(file)) return null;
  ensureDir(backupDir);
  const ext = path.extname(file) || '.json';
  const base = path.basename(file, path.extname(file));
  let name = `${label || base}-${timestamp()}${ext}`;
  let target = path.join(backupDir, name);
  let i = 1;
  while (exists(target)) {
    name = `${label || base}-${timestamp()}-${i}${ext}`;
    target = path.join(backupDir, name);
    i++;
  }
  try {
    fs.copyFileSync(file, target);
  } catch (err) {
    throw explainFsError(err, target);
  }
  return target;
}

/** 列出目录下的文件（不存在则返回空） */
export function listFiles(dir: string, ext?: string): string[] {
  if (!isDir(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => (ext ? f.endsWith(ext) : true))
      .map((f) => path.join(dir, f))
      .filter((p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });
  } catch (err) {
    throw explainFsError(err, dir);
  }
}

/** 移动文件（跨盘时退化为复制 + 删除） */
export function moveFile(src: string, dest: string): void {
  ensureDir(path.dirname(dest));
  try {
    fs.renameSync(src, dest);
  } catch {
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } catch (err) {
      throw explainFsError(err, dest);
    }
  }
}

/** 检查目录可写 */
export function assertWritable(dir: string): void {
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.wb-switch-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    if (err instanceof EnvError) throw err;
    throw new EnvError(
      `目录不可写：${dir}`,
      '请检查文件夹权限，或尝试以管理员身份运行。',
    );
  }
}
