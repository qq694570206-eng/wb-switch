/**
 * 统一错误类型与退出码。
 *
 * 退出码约定（与常见 CLI 工具保持一致）：
 *   0  成功
 *   1  一般错误（未分类）
 *   2  用法错误（参数不合法 / 缺少参数）
 *   3  配置错误（models.json 不存在 / JSON 非法 / 结构不符）
 *   4  源相关错误（源不存在 / 源已存在 / 源内容损坏）
 *   5  环境错误（目录不可写 / 权限不足 / 非交互终端）
 */

export const ExitCode = {
  OK: 0,
  GENERAL: 1,
  USAGE: 2,
  CONFIG: 3,
  PROFILE: 4,
  ENV: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class WbError extends Error {
  readonly code: ExitCodeValue;
  /** 给用户的修复建议，可为空 */
  readonly hint?: string;

  constructor(message: string, code: ExitCodeValue = ExitCode.GENERAL, hint?: string) {
    super(message);
    this.name = 'WbError';
    this.code = code;
    this.hint = hint;
  }
}

export class UsageError extends WbError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.USAGE, hint);
    this.name = 'UsageError';
  }
}

export class ConfigError extends WbError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.CONFIG, hint);
    this.name = 'ConfigError';
  }
}

export class ProfileError extends WbError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.PROFILE, hint);
    this.name = 'ProfileError';
  }
}

export class EnvError extends WbError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.ENV, hint);
    this.name = 'EnvError';
  }
}

/** 从任意异常中提取可读信息 */
export function describeError(err: unknown): string {
  if (err instanceof WbError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Node 的系统错误转成友好文案 */
export function explainFsError(err: unknown, target: string): WbError {
  const e = err as NodeJS.ErrnoException;
  switch (e?.code) {
    case 'EACCES':
    case 'EPERM':
      return new EnvError(
        `没有权限访问：${target}`,
        '请以管理员身份运行，或检查文件的只读属性。',
      );
    case 'EBUSY':
      return new EnvError(
        `文件被占用：${target}`,
        'WorkBuddy 可能正在写入配置，请稍后重试或先退出 WorkBuddy。',
      );
    case 'ENOENT':
      return new EnvError(`路径不存在：${target}`);
    case 'ENOSPC':
      return new EnvError('磁盘空间不足，无法写入配置。');
    default:
      return new WbError(`操作失败：${target}（${e?.code ?? describeError(err)}）`);
  }
}
