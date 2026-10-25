/**
 * 协议转换代理。
 *
 * 在本地起一个 HTTP 服务器，监听 OpenAI 格式的 /v1/chat/completions 请求，
 * 根据模型的目标协议（OpenAI / Anthropic / Gemini）翻译后转发给真实网关，
 * 再把响应翻译回 OpenAI 格式返回给 WorkBuddy。
 *
 * WorkBuddy 只需要把 models.json 里的 url 指向本代理（http://127.0.0.1:PORT/v1/chat/completions），
 * 代理根据 model 字段查找该模型的「真实目标 URL + 协议类型」，做翻译转发。
 *
 * 支持的协议转换：
 *   - openai   → 直通（不翻译，只转发）
 *   - anthropic → OpenAI Chat → Anthropic Messages 翻译
 *   - gemini   → OpenAI Chat → Gemini generateContent 翻译
 */

import http from 'node:http';
import { URL } from 'node:url';

export type ProtocolKind = 'openai' | 'anthropic' | 'gemini';

export interface ProxyModelConfig {
  /** WorkBuddy 请求时填的 model id */
  modelId: string;
  /** 真实网关的 chat 端点 */
  targetUrl: string;
  /** API Key */
  apiKey: string;
  /** 目标协议 */
  protocol: ProtocolKind;
}

export interface ProxyOptions {
  /** 监听端口，0=自动选 */
  port?: number;
  /** 模型路由表 */
  models: Map<string, ProxyModelConfig>;
  /** 代理地址（可选） */
  proxyUrl?: string;
}

/** 把 OpenAI Chat Completions 请求翻译成 Anthropic Messages 格式 */
function toAnthropic(body: any): any {
  const messages = body.messages || [];
  // 提取 system message
  let system = '';
  const chatMessages: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
    } else {
      chatMessages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content });
    }
  }
  const result: any = {
    model: body.model,
    messages: chatMessages,
    max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
  };
  if (system) result.system = system;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  // tools 翻译
  if (body.tools) {
    result.tools = body.tools.map((t: any) => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
    }));
  }
  if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' };
  if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
  if (body.stream) result.stream = true;
  return result;
}

/** 把 Anthropic Messages 响应翻译回 OpenAI 格式 */
function fromAnthropic(resp: any, model: string): any {
  const content = (resp.content || []).map((b: any) => b.text || '').join('');
  const toolCalls = (resp.content || [])
    .filter((b: any) => b.type === 'tool_use')
    .map((b: any, i: number) => ({
      id: b.id || `call_${i}`,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));
  const message: any = { role: 'assistant', content: content || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: resp.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: resp.stop_reason === 'tool_use' ? 'tool_calls' : 'stop' }],
    usage: resp.usage
      ? {
          prompt_tokens: resp.usage.input_tokens || 0,
          completion_tokens: resp.usage.output_tokens || 0,
          total_tokens: (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0),
        }
      : undefined,
  };
}

/** 把 OpenAI Chat Completions 请求翻译成 Gemini generateContent 格式 */
function toGemini(body: any, model: string): any {
  const messages = body.messages || [];
  let systemInstruction: string | undefined;
  const contents: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
      });
    }
  }
  const result: any = {
    contents,
    generationConfig: {
      temperature: body.temperature ?? 1,
      topP: body.top_p ?? 0.95,
      maxOutputTokens: body.max_tokens || body.max_completion_tokens || 8192,
    },
  };
  if (systemInstruction) result.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (body.tools) {
    result.tools = [{
      functionDeclarations: body.tools.map((t: any) => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description,
        parameters: t.function?.parameters || t.parameters || { type: 'object', properties: {} },
      })),
    }];
  }
  return result;
}

/** 把 Gemini generateContent 响应翻译回 OpenAI 格式 */
function fromGemini(resp: any, model: string): any {
  const parts = resp.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p: any) => p.text || '').join('');
  const toolCalls = parts
    .filter((p: any) => p.functionCall)
    .map((p: any, i: number) => ({
      id: `call_${i}`,
      type: 'function',
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args) },
    }));
  const message: any = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const finishReason = resp.candidates?.[0]?.finishReason;
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? 'tool_calls' : (finishReason === 'STOP' ? 'stop' : 'stop'),
    }],
    usage: resp.usageMetadata
      ? {
          prompt_tokens: resp.usageMetadata.promptTokenCount || 0,
          completion_tokens: resp.usageMetadata.candidatesTokenCount || 0,
          total_tokens: resp.usageMetadata.totalTokenCount || 0,
        }
      : undefined,
  };
}

/** 创建协议转换代理服务器 */
export function createProxy(opts: ProxyOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    // 只处理 POST /v1/chat/completions
    if (req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    let bodyStr = '';
    for await (const chunk of req) bodyStr += chunk;
    let body: any;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const modelId = body.model;
    const cfg = opts.models.get(modelId);
    if (!cfg) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Model "${modelId}" not configured in proxy` } }));
      return;
    }

    try {
      let targetUrl = cfg.targetUrl;
      let payload: string;
      let headers: Record<string, string>;

      if (cfg.protocol === 'openai') {
        // 直通
        payload = bodyStr;
        headers = {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
          'x-api-key': cfg.apiKey,
        };
      } else if (cfg.protocol === 'anthropic') {
        // 翻译成 Anthropic Messages 格式
        const translated = toAnthropic(body);
        // 目标 URL：把 .../chat/completions 换成 .../messages
        targetUrl = targetUrl.replace(/\/chat\/completions$/, '/messages');
        payload = JSON.stringify(translated);
        headers = {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        };
      } else if (cfg.protocol === 'gemini') {
        // 翻译成 Gemini generateContent 格式
        const translated = toGemini(body, modelId);
        // 目标 URL：https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=KEY
        const geminiBase = targetUrl.replace(/\/(openai\/)?chat\/completions?$/, '');
        targetUrl = `${geminiBase.replace(/\/v1beta\/?$/, '')}/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;
        // 把 key 拼到 query string
        targetUrl += `?key=${encodeURIComponent(cfg.apiKey)}`;
        payload = JSON.stringify(translated);
        headers = { 'content-type': 'application/json' };
      } else {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown protocol: ${cfg.protocol}` }));
        return;
      }

      // 用 fetch 转发
      const fetchOpts: any = {
        method: 'POST',
        headers,
        body: payload,
      };
      // 代理
      const proxyUrl = opts.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
      if (proxyUrl) {
        try {
          const { ProxyAgent } = require('undici');
          fetchOpts.dispatcher = new ProxyAgent({ uri: proxyUrl });
        } catch { /* 忽略 */ }
      }

      const upstream = await fetch(targetUrl, fetchOpts);
      const respText = await upstream.text();

      if (!upstream.ok) {
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(respText);
        return;
      }

      // 翻译响应回 OpenAI 格式
      let respJson: any;
      try {
        respJson = JSON.parse(respText);
      } catch {
        // 非 JSON 响应，原样返回
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(respText);
        return;
      }

      let openaiResp: any;
      if (cfg.protocol === 'anthropic') {
        openaiResp = fromAnthropic(respJson, modelId);
      } else if (cfg.protocol === 'gemini') {
        openaiResp = fromGemini(respJson, modelId);
      } else {
        openaiResp = respJson; // openai 直通
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(openaiResp));
    } catch (err: any) {
      // 聚合错误 cause
      let msg = err.message;
      if (err.cause?.errors) {
        for (const e of err.cause.errors) {
          if (e.code === 'ECONNREFUSED') { msg = '连接被拒绝，网关可能未启动'; break; }
          if (e.code === 'ENOTFOUND') { msg = '域名解析失败'; break; }
        }
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Proxy error: ${msg}` } }));
    }
  });

  const port = opts.port || 0;
  return server;
}

/** 启动代理并返回实际监听端口和关闭函数 */
export function startProxy(opts: ProxyOptions): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve) => {
    const server = createProxy(opts);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port || 0;
      resolve({
        port,
        stop: () => server.close(),
      });
    });
  });
}
