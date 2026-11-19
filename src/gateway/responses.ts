/**
 * OpenAI Responses API ↔ Chat Completions 协议转换。
 *
 * 背景：Codex CLI 只支持 `wire_api = "responses"`（打 /v1/responses），
 * 而绝大多数中转站 / 中转网关只提供 /v1/chat/completions。
 * 网关在这里做双向翻译，让任何 chat 上游都能给 Codex 用。
 *
 * 请求方向：responses → chat
 *   input（字符串或消息数组）→ messages
 *   instructions / developer 消息 → system
 *   max_output_tokens → max_tokens
 *   tools（function 扁平结构）→ tools（function 嵌套结构）
 *   reasoning.effort → reasoning_effort
 *
 * 响应方向：chat → responses
 *   choices[0].message.content → output[].content[].text（message 项）
 *   tool_calls → output[] 里的 function_call 项
 *   流式：chat 的 delta chunk → responses 的 response.output_text.delta 等事件
 */

/** responses 请求转 chat 请求体 */
export function responsesToChat(body: Record<string, unknown>): {
  payload: Record<string, unknown>;
  stream: boolean;
} {
  const messages: Record<string, unknown>[] = [];

  // 1) instructions 作为 system
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }

  // 2) input：字符串 = 单条 user；数组 = 混合条目
  const input = body.input;
  if (typeof input === 'string') {
    if (input.trim()) messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const itemRaw of input) {
      const item = itemRaw as Record<string, unknown>;
      // 消息型：{ type:'message', role, content }
      const type = typeof item.type === 'string' ? item.type : '';
      if (type === 'message' || (!type && item.role)) {
        const role = normalizeRole(item.role);
        const content = convertContent(item.content);
        if (content !== null) messages.push({ role, content });
        continue;
      }
      // function_call_output（工具返回值）
      if (type === 'function_call_output') {
        const out = item.output;
        const text = typeof out === 'string' ? out : JSON.stringify(out ?? '');
        messages.push({
          role: 'tool',
          tool_call_id: String(item.call_id ?? item.id ?? ''),
          content: text,
        });
        continue;
      }
      // function_call（上一轮助手发起的工具调用，回灌到 assistant.tool_calls）
      if (type === 'function_call') {
        const callId = String(item.call_id ?? item.id ?? '');
        const name = String(item.name ?? '');
        const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }],
        });
        continue;
      }
      // 其它（reasoning 等）忽略：chat 上游不认
    }
  }

  // 3) max tokens
  const payload: Record<string, unknown> = {
    model: body.model,
    messages,
  };
  if (typeof body.max_output_tokens === 'number') payload.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  if (typeof body.top_p === 'number') payload.top_p = body.top_p;
  // 流式：必须把 stream 传给上游，否则上游返回普通 JSON，
  // 而这里会当 SSE 解析，结果客户端收到空响应。
  if (body.stream === true) payload.stream = true;

  // 4) 推理强度
  const reasoning = body.reasoning as { effort?: unknown } | undefined;
  if (reasoning && typeof reasoning.effort === 'string') {
    payload.reasoning_effort = reasoning.effort;
  }

  // 5) 工具：responses 是扁平 function，chat 要包一层 function
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = (body.tools as Record<string, unknown>[])
      .filter((t) => t && (t.type === 'function' || typeof t.name === 'string'))
      .map((t) => {
        // 已经是 chat 结构就原样保留
        if (t.type === 'function' && t.function) return t;
        return {
          type: 'function',
          function: {
            name: String(t.name ?? ''),
            description: typeof t.description === 'string' ? t.description : undefined,
            parameters: t.parameters ?? { type: 'object', properties: {} },
          },
        };
      });
    if (tools.length) payload.tools = tools;
  }
  if (typeof body.tool_choice === 'string') payload.tool_choice = body.tool_choice;
  if (typeof body.parallel_tool_calls === 'boolean') payload.parallel_tool_calls = body.parallel_tool_calls;

  return {
    payload,
    stream: body.stream === true,
  };
}

/** 角色归一化：developer → system（chat 上游普遍不支持 developer） */
function normalizeRole(role: unknown): string {
  const r = typeof role === 'string' ? role.toLowerCase() : 'user';
  if (r === 'developer') return 'system';
  if (r === 'system' || r === 'user' || r === 'assistant' || r === 'tool') return r;
  return 'user';
}

/**
 * responses 的 content 转 chat 的 content。
 * responses: [{ type:'input_text'|'text', text }, { type:'input_image', image_url }]
 * chat:      "字符串" 或 [{ type:'text', text }, { type:'image_url', image_url:{url} }]
 */
function convertContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: Record<string, unknown>[] = [];
  const texts: string[] = [];
  for (const pRaw of content) {
    const p = pRaw as Record<string, unknown>;
    const t = typeof p.type === 'string' ? p.type : '';
    if (t === 'input_text' || t === 'text' || t === 'output_text') {
      const txt = typeof p.text === 'string' ? p.text : '';
      texts.push(txt);
      parts.push({ type: 'text', text: txt });
    } else if (t === 'input_image' || t === 'image_url') {
      const url =
        typeof p.image_url === 'string'
          ? p.image_url
          : (p.image_url as { url?: string } | undefined)?.url ?? (typeof p.url === 'string' ? p.url : '');
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  // 纯文本时降级成字符串（兼容性最好）
  if (parts.every((p) => p.type === 'text')) return texts.join('');
  return parts.length ? parts : '';
}

/** chat 响应（非流式）转 responses 响应 */
export function chatToResponses(
  chat: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const choices = Array.isArray(chat.choices) ? (chat.choices as Record<string, unknown>[]) : [];
  const first = choices[0] ?? {};
  const message = (first.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === 'string' ? message.content : '';
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Record<string, unknown>[]) : [];

  const output: Record<string, unknown>[] = [];

  // 推理内容（部分上游单独返回）
  if (reasoning) {
    output.push({
      type: 'reasoning',
      id: `rs_${Date.now().toString(36)}`,
      summary: [{ type: 'summary_text', text: reasoning }],
    });
  }

  // 正文
  if (content) {
    output.push({
      type: 'message',
      id: `msg_${Date.now().toString(36)}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    });
  }

  // 工具调用
  for (const tc of toolCalls) {
    const fn = (tc.function ?? {}) as Record<string, unknown>;
    output.push({
      type: 'function_call',
      id: `fc_${String(tc.id ?? Date.now().toString(36))}`,
      call_id: String(tc.id ?? ''),
      name: String(fn.name ?? ''),
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      status: 'completed',
    });
  }

  const usage = (chat.usage ?? {}) as Record<string, unknown>;
  return {
    id: `resp_${Date.now().toString(36)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    output,
    output_text: content,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
      total_tokens: Number(usage.total_tokens ?? 0),
    },
  };
}

/** 流式事件构造器（responses SSE 的每个事件都形如 { type, ... }） */
export function sseEvent(obj: Record<string, unknown>): string {
  return `event: ${String(obj.type ?? 'message')}\ndata: ${JSON.stringify(obj)}\n\n`;
}

/**
 * 把 chat 的流式增量转成 responses 事件序列。
 * 用法：逐 chunk 调 feed()，拿到要写给客户端的事件文本。
 */
export class ChatToResponsesStreamer {
  private seq = 0;
  private responseId = `resp_${Date.now().toString(36)}`;
  private started = false;
  private outputIndex = 0;
  private textBuffer = '';
  private itemId = `msg_${Date.now().toString(36)}`;
  private toolCalls = new Map<number, { id: string; name: string; args: string }>();
  private finished = false;

  constructor(private model: string) {}

  /** 开始：发 response.created / output_item.added */
  start(): string {
    if (this.started) return '';
    this.started = true;
    return (
      sseEvent({
        type: 'response.created',
        response: {
          id: this.responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: this.model,
          status: 'in_progress',
          output: [],
        },
      }) +
      sseEvent({
        type: 'response.output_item.added',
        output_index: this.outputIndex,
        item: {
          type: 'message',
          id: this.itemId,
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      })
    );
  }

  /** 处理一个 chat 流式 chunk，返回要写出的事件 */
  feed(chunk: Record<string, unknown>): string {
    let out = this.start();
    const choices = Array.isArray(chunk.choices) ? (chunk.choices as Record<string, unknown>[]) : [];
    const choice = choices[0] as Record<string, unknown> | undefined;
    if (!choice) return out;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    // 正文增量
    const text = typeof delta.content === 'string' ? delta.content : '';
    if (text) {
      if (!this.textBuffer) {
        out += sseEvent({
          type: 'response.content_part.added',
          item_id: this.itemId,
          output_index: this.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      }
      this.textBuffer += text;
      out += sseEvent({
        type: 'response.output_text.delta',
        item_id: this.itemId,
        output_index: this.outputIndex,
        content_index: 0,
        delta: text,
      });
    }

    // 工具调用增量
    const tcs = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Record<string, unknown>[]) : [];
    for (const tc of tcs) {
      const idx = Number(tc.index ?? 0);
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      const existing = this.toolCalls.get(idx) ?? { id: '', name: '', args: '' };
      if (typeof tc.id === 'string') existing.id = tc.id;
      if (typeof fn.name === 'string') existing.name = fn.name;
      if (typeof fn.arguments === 'string') existing.args += fn.arguments;
      this.toolCalls.set(idx, existing);
    }

    return out;
  }

  /** 结束：发收尾事件（含 output_text.done / completed） */
  end(usage?: Record<string, unknown>): string {
    if (this.finished) return '';
    this.finished = true;
    let out = this.start();

    // 收尾正文本项
    if (this.textBuffer) {
      out += sseEvent({
        type: 'response.output_text.done',
        item_id: this.itemId,
        output_index: this.outputIndex,
        content_index: 0,
        text: this.textBuffer,
      });
      out += sseEvent({
        type: 'response.output_item.done',
        output_index: this.outputIndex,
        item: {
          type: 'message',
          id: this.itemId,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: this.textBuffer, annotations: [] }],
        },
      });
      this.outputIndex++;
    }

    // 工具调用项
    for (const [, tc] of this.toolCalls) {
      const id = tc.id || `fc_${Date.now().toString(36)}`;
      out += sseEvent({
        type: 'response.output_item.added',
        output_index: this.outputIndex,
        item: { type: 'function_call', id, call_id: id, name: tc.name, arguments: '', status: 'in_progress' },
      });
      out += sseEvent({
        type: 'response.function_call_arguments.delta',
        item_id: id,
        output_index: this.outputIndex,
        delta: tc.args,
      });
      out += sseEvent({
        type: 'response.output_item.done',
        output_index: this.outputIndex,
        item: {
          type: 'function_call',
          id,
          call_id: id,
          name: tc.name,
          arguments: tc.args,
          status: 'completed',
        },
      });
      this.outputIndex++;
    }

    out += sseEvent({
      type: 'response.completed',
      response: {
        id: this.responseId,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: this.model,
        status: 'completed',
        usage: {
          input_tokens: Number(usage?.prompt_tokens ?? 0),
          output_tokens: Number(usage?.completion_tokens ?? 0),
          total_tokens: Number(usage?.total_tokens ?? 0),
        },
      },
    });
    return out;
  }
}
