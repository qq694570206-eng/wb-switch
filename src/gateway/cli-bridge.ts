/**
 * CLI 内部桥接类型：gateway/cli.ts 需要主 CLI 的 Args 结构，
 * 抽出来避免 cli.ts ↔ gateway/cli.ts 循环引用。
 */

export interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
  configDir?: string;
}
