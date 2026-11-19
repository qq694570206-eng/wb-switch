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
  /** 仅推理模型（纯思考，不产出可见回答） */
  onlyReasoning?: boolean;
  useCustomProtocol?: boolean;
  /** 最大输入 token 数（上下文窗口） */
  maxInputTokens?: number;
  /** 最大输出 token 数 */
  maxOutputTokens?: number;
  /** 思考强度（reasoning effort）配置：是否支持 + 可选档位 */
  reasoning?: {
    /** 支持的思考强度档位，如 ['low','medium','high'] */
    supportedEfforts?: string[];
    [key: string]: unknown;
  };
  /** 保留未知字段，切换时原样写回，避免丢失新版客户端的配置项 */
  [key: string]: unknown;
}

/** 一个源：即一份完整的 models.json 快照 */
export interface Profile {
  /** 源名称，同时是文件名（经安全化处理） */
  name: string;
  /** 可选描述 */
  description?: string;
  /**
   * 源类型：
   *   - 普通（缺省）：models = 完整 models.json 快照，切换 = 整体替换
   *   - combo 组合：models 为聚合产物，切换 = 追加模式（不覆盖当前已选源）
   *   - gateway 网关源：bind 生成的网关别名条目
   */
  type?: 'normal' | 'combo' | 'gateway';
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
  /**
   * 仅 combo：组合的成员定义（每个条目可引用不同源的模型，别名不要求同名）。
   * 生成 models 时按序展开为 ModelEntry。
   */
  combo?: ComboMember[];
}

/** 组合成员：一个别名 + 按序尝试的多个（源,模型）后端 */
export interface ComboMember {
  /** WorkBuddy 里显示的模型名（组合内唯一） */
  alias: string;
  /** 按序尝试的后端；失败（重试 10 次后）切下一个 */
  sources: { profile: string; model: string }[];
}

/** 当前激活源指针（state.json） */
export interface SwitchState {
  /** 当前激活的源名称；null 表示未通过本工具切换过 */
  active: string | null;
  /** 上次切换时间 ISO 字符串 */
  updatedAt: string | null;
  /** 上次切换前的备份文件名 */
  lastBackup?: string | null;
  /**
   * 追加模式：选中组合或追加普通源时记录追加顺序（不覆盖 active）。
   * active 保持首个被选中的源；appendended 记录其后按序追加的组合/源。
   */
  appended?: string[];
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
