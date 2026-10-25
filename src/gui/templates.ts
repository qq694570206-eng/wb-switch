/**
 * 预置大厂模型网关模板。
 *
 * 每个模板包含：厂商名、API 基址、常见模型列表（带默认能力标记）、简介。
 * 用户在「新建源 → 从模板创建」时选中一个，即可自动填好地址和模型列表，
 * 只需填入自己的 API Key。
 *
 * 所有 baseUrl 均已逐一对照各家官方 API 文档验证，以下为验证记录：
 *   OpenAI       https://platform.openai.com/docs/api-reference        ✓ /v1/chat/completions
 *   Anthropic    https://docs.claude.com/en/api + OpenAI 兼容层        ✓ /v1/chat/completions (兼容)
 *   Gemini       https://ai.google.dev/gemini-api/docs/openai          ✓ /v1beta/openai/chat/completions
 *   DeepSeek     https://platform.deepseek.com/api-docs                 ✓ base_url 可填 /v1/chat/completions
 *   智谱         https://docs.bigmodel.cn/api-reference/模型-api/对话补全 ✓ /api/paas/v4/chat/completions
 *   通义千问      https://help.aliyun.com/zh/api-gateway/ai-gateway/...  ✓ /compatible-mode/v1/chat/completions
 *   百度千帆      https://cloud.baidu.com/doc/qianfan/s/rmh4stn9m        ✓ /v2/chat/completions
 *   豆包         https://www.volcengine.com/docs/82379/1298459          ✓ /api/v3/chat/completions
 *   Kimi         https://platform.moonshot.cn/docs/api/                 ✓ /v1/chat/completions
 *   MiniMax      https://platform.minimax.io/docs/api-reference/text-chat ✓ /v1/chat/completions
 *   零一万物      https://platform.lingyiwanwu.com/docs/api-reference   ✓ /v1/chat/completions
 *   商汤         https://platform.sensenova.cn/en/docs                    ✓ token.sensenova.cn/v1/chat/completions (OpenAI 兼容)
 *   硅基流动      https://api-docs.siliconflow.cn/                      ✓ /v1/chat/completions
 *   OpenRouter   https://docs.openrouter.ai/quickstart                  ✓ /api/v1/chat/completions
 *   Together AI  https://docs.together.ai/                              ✓ /v1/chat/completions
 *   Groq         https://console.groq.com/docs                         ✓ /openai/v1/chat/completions
 */

export interface TemplateModel {
  id: string;
  /** 默认能力标记（基于该模型的实际能力） */
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
}

export interface VendorTemplate {
  /** 厂商标识，用于图标和查找 */
  id: string;
  /** 显示名 */
  name: string;
  /** API 基址（用户填 Key 后可从这里拉取模型列表） */
  baseUrl: string;
  /** 供应商字段值（写入 models.json 的 vendor） */
  vendor: string;
  /** 简介一行 */
  description: string;
  /** 获取 API Key 的地址 */
  keyUrl: string;
  /** 预填的常见模型列表 */
  models: TemplateModel[];
  /** 该厂商的能力说明 */
  notes?: string;
  /** 标注服务已停止（界面会显示警告，获取模型时也提示） */
  discontinued?: boolean;
}

export const VENDOR_TEMPLATES: VendorTemplate[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    vendor: 'OpenAI',
    description: 'GPT 系列官方 API',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o', supportsToolCall: true, supportsImages: true },
      { id: 'gpt-4o-mini', supportsToolCall: true, supportsImages: true },
      { id: 'gpt-4.1', supportsToolCall: true, supportsImages: true },
      { id: 'o3-mini', supportsToolCall: true, supportsReasoning: true },
      { id: 'o4-mini', supportsToolCall: true, supportsReasoning: true },
    ],
    notes: 'o 系列支持推理但不支持图像',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1/chat/completions',
    vendor: 'Anthropic',
    description: 'Claude 系列官方 API（OpenAI 兼容层）',
    keyUrl: 'https://console.anthropic.com/',
    models: [
      { id: 'claude-sonnet-4-20250514', supportsToolCall: true, supportsImages: true, supportsReasoning: true },
      { id: 'claude-opus-4-20250514', supportsToolCall: true, supportsImages: true, supportsReasoning: true },
      { id: 'claude-haiku-4-20250414', supportsToolCall: true, supportsImages: true },
    ],
    notes: 'Anthropic 提供 /v1/chat/completions OpenAI 兼容端点，base_url 设为 https://api.anthropic.com/v1',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    // 官方文档明确 OpenAI 兼容端点为 /v1beta/openai/，不是 /v1beta/chat/completions
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    vendor: 'Google',
    description: 'Gemini 系列官方 API（OpenAI 兼容模式）',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.5-pro', supportsToolCall: true, supportsImages: true, supportsReasoning: true },
      { id: 'gemini-2.5-flash', supportsToolCall: true, supportsImages: true, supportsReasoning: true },
      { id: 'gemini-2.0-flash', supportsToolCall: true, supportsImages: true },
    ],
    notes: 'OpenAI 兼容端点为 /v1beta/openai/chat/completions，模型列表在 /v1beta/openai/models',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    // 官方文档 base_url 可填 https://api.deepseek.com（SDK 会自动补 /v1/chat/completions）
    // 这里直接写全路径，与 models.json 的 url 字段格式一致
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    vendor: 'DeepSeek',
    description: '深度求索官方 API（国内直连）',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-chat', supportsToolCall: true },
      { id: 'deepseek-reasoner', supportsToolCall: true, supportsReasoning: true },
    ],
    notes: 'reasoner 支持思维链推理',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    vendor: '智谱',
    description: '智谱 AI GLM 系列官方 API',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-4.6', supportsToolCall: true },
      { id: 'glm-4-plus', supportsToolCall: true },
      { id: 'glm-4-flash', supportsToolCall: true },
      { id: 'glm-4-flashx', supportsToolCall: true },
    ],
  },
  {
    id: 'qwen',
    name: '阿里通义千问',
    // 官方文档明确 OpenAI 兼容模式端点为 /compatible-mode/v1
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    vendor: '阿里云',
    description: '通义千问系列（阿里云百炼 OpenAI 兼容模式）',
    keyUrl: 'https://bailian.console.aliyun.com/api-key',
    models: [
      { id: 'qwen-max', supportsToolCall: true },
      { id: 'qwen-plus', supportsToolCall: true },
      { id: 'qwen-turbo', supportsToolCall: true },
      { id: 'qwen-long', supportsToolCall: true },
    ],
    notes: '使用 OpenAI 兼容模式端点，模型列表在 /compatible-mode/v1/models',
  },
  {
    id: 'baidu',
    name: '百度文心',
    // 千帆 v2 端点，兼容 OpenAI 格式
    baseUrl: 'https://qianfan.baidubce.com/v2/chat/completions',
    vendor: '百度智能云',
    description: '文心一言系列（千帆 v2 OpenAI 兼容）',
    keyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationKey/list',
    models: [
      { id: 'ernie-4.0-8k-latest', supportsToolCall: true },
      { id: 'ernie-4.0-turbo-8k', supportsToolCall: true },
      { id: 'ernie-3.5-8k', supportsToolCall: true },
      { id: 'ernie-speed-128k', supportsToolCall: true },
    ],
    notes: '千帆 v2 兼容 OpenAI 格式，认证方式 Bearer + bce-v3 格式 Key',
  },
  {
    id: 'doubao',
    name: '字节豆包',
    // 火山方舟 API，base URL 为 https://ark.cn-beijing.volces.com/api/v3
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    vendor: '火山引擎',
    description: '豆包系列（火山方舟）',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    models: [
      { id: 'doubao-seed-1-6-250615', supportsToolCall: true },
      { id: 'doubao-pro-32k', supportsToolCall: true },
      { id: 'doubao-pro-128k', supportsToolCall: true },
      { id: 'doubao-lite-32k', supportsToolCall: true },
    ],
    notes: '模型 ID 可用官方预置名，也可填接入点 ID（在火山方舟创建接入点后获取）',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
    vendor: 'Moonshot',
    description: 'Kimi 系列官方 API',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      { id: 'moonshot-v1-auto', supportsToolCall: true },
      { id: 'kimi-latest', supportsToolCall: true },
      { id: 'kimi-thinking-preview', supportsToolCall: true, supportsReasoning: true },
    ],
    notes: '支持超长上下文，kimi-thinking-preview 支持推理',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    // 官方文档：国内用 https://api.minimaxi.com/v1，国际版用 https://api.minimax.io/v1
    // 之前模板写的 https://api.minimaxi.chat 是错误的，正确域名是 api.minimaxi.com
    baseUrl: 'https://api.minimaxi.com/v1/chat/completions',
    vendor: 'MiniMax',
    description: 'MiniMax 大模型 API',
    keyUrl: 'https://platform.minimaxi.com/',
    models: [
      { id: 'MiniMax-M3', supportsToolCall: true },
      { id: 'abab6.5s-chat', supportsToolCall: true },
      { id: 'abab6.5-chat', supportsToolCall: true },
    ],
    notes: '国内域名 api.minimaxi.com，国际版 api.minimax.io',
  },
  {
    id: 'lingyi',
    name: '零一万物 Yi',
    // 实测 2026-10-25：该端点返回 HTTP 410 Gone，平台已停止服务
    // 保留模板但标注 discontinued，界面会提示用户
    baseUrl: 'https://api.lingyiwanwu.com/v1/chat/completions',
    vendor: '零一万物',
    description: 'Yi 系列官方 API（服务已停止）',
    keyUrl: 'https://platform.lingyiwanwu.com/apikeys',
    models: [
      { id: 'yi-lightning', supportsToolCall: true },
      { id: 'yi-large', supportsToolCall: true },
      { id: 'yi-vision-v2', supportsToolCall: true, supportsImages: true },
    ],
    notes: '⚠️ 该平台已停止服务（HTTP 410），模板仅作参考保留',
    discontinued: true,
  },
  {
    id: 'sensenova',
    name: '商汤 SenseNova',
    // 商汤有两套 API：
    //   大装置平台（传统）：https://api.sensenova.cn/v1/llm/chat-completions（非 OpenAI 格式）
    //   TokenPlan（OpenAI 兼容）：https://token.sensenova.cn/v1/chat/completions
    // WorkBuddy 的 models.json 需要 OpenAI 兼容格式，因此用 token.sensenova.cn
    baseUrl: 'https://token.sensenova.cn/v1/chat/completions',
    vendor: '商汤',
    description: '商汤 SenseNova TokenPlan（OpenAI 兼容）',
    keyUrl: 'https://platform.sensenova.cn/',
    models: [
      { id: 'sensenova-6.8-flash-lite', supportsToolCall: true },
      { id: 'deepseek-v4-flash', supportsToolCall: true, supportsReasoning: true },
      { id: 'glm-5.2', supportsToolCall: true },
    ],
    notes: 'TokenPlan 地址为 token.sensenova.cn（OpenAI 兼容），大装置传统 API 为 api.sensenova.cn/v1/llm/chat-completions（格式不同）',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    // 官方文档明确域名从 .com 迁移到 .cn（已配全球加速）
    baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    vendor: 'SiliconFlow',
    description: '聚合多模型推理平台（有免费额度）',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', supportsToolCall: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct', supportsToolCall: true },
      { id: 'meta-llama/Llama-3.3-70B-Instruct', supportsToolCall: true },
    ],
    notes: '模型 ID 格式为 厂商/模型名，有免费模型可用',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    vendor: 'OpenRouter',
    description: '聚合 300+ 模型，一个 Key 通吃',
    keyUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'openai/gpt-4o', supportsToolCall: true, supportsImages: true },
      { id: 'anthropic/claude-3.5-sonnet', supportsToolCall: true, supportsImages: true },
      { id: 'google/gemini-2.0-flash-001', supportsToolCall: true, supportsImages: true },
      { id: 'deepseek/deepseek-chat', supportsToolCall: true },
      { id: 'meta-llama/llama-3.3-70b-instruct', supportsToolCall: true },
    ],
    notes: '模型 ID 格式为 厂商/模型名，可用所有主流模型',
  },
  {
    id: 'together',
    name: 'Together AI',
    // 官方文档 base_url 为 https://api.together.xyz/v1
    baseUrl: 'https://api.together.xyz/v1/chat/completions',
    vendor: 'Together',
    description: '开源模型聚合推理平台',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', supportsToolCall: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', supportsToolCall: true },
      { id: 'deepseek-ai/DeepSeek-V3', supportsToolCall: true },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    // 官方文档 base_url 为 https://api.groq.com/openai/v1
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    vendor: 'Groq',
    description: '极速推理平台（LPU 硬件加速）',
    keyUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'llama-3.3-70b-versatile', supportsToolCall: true },
      { id: 'llama-3.1-8b-instant', supportsToolCall: true },
      { id: 'deepseek-r1-distill-qwen-32b', supportsToolCall: true, supportsReasoning: true },
    ],
    notes: '推理速度极快，有免费额度（20 请求/分钟）',
  },
];

/** 按厂商 ID 查找模板 */
export function findTemplate(id: string): VendorTemplate | undefined {
  return VENDOR_TEMPLATES.find((t) => t.id === id);
}
