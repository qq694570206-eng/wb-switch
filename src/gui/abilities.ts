/**
 * 模型能力自动识别。
 *
 * /models 接口通常只返回 id 列表，不含能力信息；用户也未必清楚每个模型
 * 支不支持推理 / 图像 / 工具调用。这里按「模型名规则 + 已知模型库」推断，
 * 拉取模型后自动填好能力字段，省去逐个手配。
 *
 * 识别结果只是「预填默认值」，用户在界面上仍可手动改。
 */

/** 一个模型推断出的能力集 */
export interface ModelAbilities {
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  onlyReasoning: boolean;
  /** 思考强度档位；null = 不支持/未知 */
  reasoningEfforts: string[] | null;
  /** 置信度：known = 来自内置知识库；heuristic = 按命名规则猜 */
  basis: 'known' | 'heuristic';
}

const DEFAULT_EFFORTS = ['low', 'medium', 'high'];

/** 已知模型的思考强度档位（与官方文档一致） */
const KNOWN_EFFORTS: Record<string, string[]> = {
  // OpenAI
  'o1': ['low', 'medium', 'high'],
  'o1-mini': ['low', 'medium', 'high'],
  'o1-preview': ['low', 'medium', 'high'],
  'o3': ['low', 'medium', 'high'],
  'o3-mini': ['low', 'medium', 'high'],
  'o3-pro': ['low', 'medium', 'high'],
  'o4-mini': ['low', 'medium', 'high'],
  'gpt-5': ['low', 'medium', 'high'],
  'gpt-5-mini': ['low', 'medium', 'high'],
  'gpt-5-nano': ['low', 'medium', 'high'],
  'gpt-5-pro': ['low', 'medium', 'high'],
  // Claude
  'claude-3-7-sonnet': ['low', 'medium', 'high'],
  'claude-sonnet-4': ['low', 'medium', 'high'],
  'claude-sonnet-4-5': ['low', 'medium', 'high'],
  'claude-opus-4-1': ['low', 'medium', 'high'],
  'claude-opus-4-5': ['low', 'medium', 'high'],
  // Gemini
  'gemini-2.5-flash': ['low', 'medium', 'high', 'none'],
  'gemini-2.5-pro': ['low', 'medium', 'high', 'none'],
  'gemini-3-pro': ['low', 'medium', 'high', 'none'],
};

/** 纯推理（不产出可见回答）的已知模型 */
const KNOWN_ONLY_REASONING = new Set([
  'o1-mini',
  'o1-preview',
]);

/** 已知模型 → 能力（id 小写精确匹配；未命中再走命名规则） */
const KNOWN_MODELS: Record<string, Partial<ModelAbilities>> = {
  // ── OpenAI ──
  'gpt-4o': { supportsImages: true },
  'gpt-4o-mini': { supportsImages: true },
  'gpt-4-turbo': { supportsImages: true },
  'gpt-4.1': { supportsImages: true },
  'gpt-4.1-mini': { supportsImages: true },
  'gpt-4.1-nano': { supportsImages: true },
  'chatgpt-4o-latest': { supportsImages: true },
  // ── Anthropic ──
  'claude-3-5-sonnet-latest': { supportsImages: true },
  'claude-3-5-haiku-latest': { supportsImages: true },
  'claude-3-opus-latest': { supportsImages: true },
  'claude-3-7-sonnet-latest': { supportsImages: true },
  'claude-sonnet-4-20250514': { supportsImages: true },
  'claude-sonnet-4-5-20250929': { supportsImages: true },
  'claude-opus-4-20250514': { supportsImages: true },
  'claude-opus-4-1-20250805': { supportsImages: true },
  'claude-opus-4-5-20251101': { supportsImages: true },
  // ── Google ──
  'gemini-2.0-flash': { supportsImages: true },
  'gemini-2.0-flash-lite': { supportsImages: true },
  'gemini-2.5-flash': { supportsImages: true },
  'gemini-2.5-pro': { supportsImages: true },
  'gemini-3-pro-preview': { supportsImages: true },
  // ── DeepSeek ──
  'deepseek-chat': { supportsImages: false },
  'deepseek-reasoner': { supportsImages: false, onlyReasoning: true },
  'deepseek-v3': {},
  'deepseek-v3.1': {},
  'deepseek-r1': { supportsImages: false, supportsReasoning: true, onlyReasoning: true },
  'deepseek-r1-0528': { supportsImages: false, supportsReasoning: true, onlyReasoning: true },
  // ── xAI ──
  'grok-2-vision': { supportsImages: true },
  'grok-3': {},
  'grok-3-mini': { supportsReasoning: true },
  'grok-4': { supportsImages: true },
  'grok-4-fast': { supportsImages: true },
  // ── 其它 ──
  'qwen-vl-max': { supportsImages: true },
  'qwen-vl-plus': { supportsImages: true },
  'qwen3-max': {},
  'glm-4.5v': { supportsImages: true },
  'glm-4.6': {},
  'kimi-k2': {},
  'moonshot-v1-8k': {},
  'doubao-seed-1.6': { supportsImages: true },
  'llama-3.2-90b-vision': { supportsImages: true },
  'mistral-large-latest': { supportsImages: true },
};

/** 命名规则（正则，i 匹配）→ 能力补丁。按序应用，后命中会覆盖前命中。 */
const HEURISTICS: { re: RegExp; patch: Partial<ModelAbilities> }[] = [
  // 视觉/多模态
  { re: /(^|[-_.])vl([-_.]|$)/i, patch: { supportsImages: true } },
  { re: /vision|多模态|-vl-/i, patch: { supportsImages: true } },
  // 推理：r1 / reasoning / thinking / -thinking / deepseek-reasoner
  { re: /(^|[-_.])(o1|o3|o4)([-_.]|$)/i, patch: { supportsReasoning: true } },
  { re: /(^|[-_.])(r1|qwq|orion)([-_.]|$)/i, patch: { supportsReasoning: true } },
  { re: /reasoner|reasoning|thinking|-think|-turbo-thinking/i, patch: { supportsReasoning: true } },
  { re: /deepseek-r\d/i, patch: { supportsReasoning: true, onlyReasoning: true } },
  // 通用图片模型多数识图
  { re: /gpt-4o|gpt-4\.1|gpt-5|gemini|claude|glm-4\.5v|glm-4\.6v|qwen.*vl|doubao-seed|grok-4/i, patch: { supportsImages: true } },
  // 可调思考强度（档位交给第 5 步兜底：推理开且无已知档位 → 通用三档）
  { re: /o1|o3|o4-mini|gpt-5|claude-(3-7|sonnet-4|opus-4)|gemini-2\.5|gemini-3/i, patch: { supportsReasoning: true } },
];

const OFF = { supportsToolCall: false, supportsImages: false, supportsReasoning: false, onlyReasoning: false };

/**
 * 识别一个模型的能力。
 * 规则：内置知识库精确命中 > 命名规则启发式 > 全默认（工具调用开、其余关）。
 */
export function detectAbilities(rawId: string): ModelAbilities {
  const id = (rawId || '').trim();
  const base: ModelAbilities = {
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: false,
    onlyReasoning: false,
    reasoningEfforts: null,
    basis: 'heuristic',
  };
  if (!id) return base;

  // 1) 内置知识库：精确 id（不带日期后缀）
  const bare = id.toLowerCase().replace(/[-_](20\d{2})\d*$/, '');
  const known = KNOWN_MODELS[bare] ?? KNOWN_MODELS[id.toLowerCase()];
  if (known) {
    Object.assign(base, known);
    base.basis = 'known';
  }

  // 2) 思考强度：知识库档位 > 命名规则推断
  const effortsFromKnown = KNOWN_EFFORTS[bare] ?? KNOWN_EFFORTS[id.toLowerCase()];
  if (effortsFromKnown) {
    base.reasoningEfforts = [...effortsFromKnown];
    base.supportsReasoning = true;
  }

  // 3) 命名规则
  for (const { re, patch } of HEURISTICS) {
    if (re.test(id)) Object.assign(base, patch);
  }

  // 4) 纯推理名单
  if (KNOWN_ONLY_REASONING.has(bare)) base.onlyReasoning = true;

  // 5) 推理开了但档位未知 → 给通用三档
  if (base.supportsReasoning && !base.reasoningEfforts) {
    base.reasoningEfforts = [...DEFAULT_EFFORTS];
  }
  // 反向兜底：没有推理能力就没有档位
  if (!base.supportsReasoning) {
    base.reasoningEfforts = null;
    base.onlyReasoning = false;
  }
  return base;
}

/** 批量识别（供拉取模型后一次性标注） */
export function detectAbilitiesBatch(ids: string[]): Record<string, ModelAbilities> {
  const out: Record<string, ModelAbilities> = {};
  for (const id of ids) out[id] = detectAbilities(id);
  return out;
}
