/**
 * wb-switch - 类型定义
 *
 * WorkBuddy 的模型配置文件 models.json 是一个模型条目数组，每个条目描述
 * 一个可用的模型源（自定义网关 / 官方 / 第三方中转等）。
 * 本工具以「源（profile）」为单位管理整份 models.json 的快照。
 */

/** models.json 中的单个模型条目（已知字段 + 允许保留未知字段） */
export interface ModelEntry {
  id: string;
  name?: string;
  vendor?: string;
  url?: string;
  apiKey?: string;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  useCustomProtocol?: boolean;
  /** 保留未知字段，切换时原样写回，避免丢失新版客户端的配置项 */
  [key: string]: unknown;
}

/** 一个源：即一份完整的 models.json 快照 */
export interface Profile {
  /** 源名称，同时是文件名（经安全化处理） */
  name: string;
  /** 可选描述 */
  description?: string;
  /** 记录来源，便于追溯 */
  origin?: {
    /** current = 从当前 models.json 快照；file = 从外部文件导入；manual = 手工添加 */
    type: 'current' | 'file' | 'manual';
    /** 导入时的原始路径 */
    path?: string;
    /** 创建时间 ISO 字符串 */
    createdAt: string;
  };
  /** 模型条目列表，与 models.json 结构完全一致 */
  models: ModelEntry[];
}

/** 当前激活源指针（state.json） */
export interface SwitchState {
  /** 当前激活的源名称；null 表示未通过本工具切换过 */
  active: string | null;
  /** 上次切换时间 ISO 字符串 */
  updatedAt: string | null;
  /** 上次切换前的备份文件名 */
  lastBackup?: string | null;
}

/** 备份记录 */
export interface BackupRecord {
  file: string;
  path: string;
  createdAt: Date;
  size: number;
}

/** 源列表条目（用于展示，附带是否为当前激活） */
export interface ProfileSummary {
  name: string;
  description?: string;
  modelCount: number;
  vendors: string[];
  hosts: string[];
  active: boolean;
  createdAt?: string;
  /** 与当前 models.json 内容是否一致 */
  inSync: boolean;
}
