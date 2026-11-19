/**
 * responses ↔ chat 协议转换回归测试（不依赖网络 / Electron）。
 *
 * 场景：Codex 只发 /v1/responses，上游只有 /v1/chat/completions，
 * 网关必须双向翻译准确，否则 Codex 直接不可用。
 *
 * 用法：node tests/responses.mjs
 */

import {
  responsesToChat,
  chatToResponses,
  ChatToResponsesStreamer,
} from '../dist/gateway/responses.js';

let pass = 0;
const fails = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    return;
  }
  fails.push(`${label}\n    期望: ${e}\n    实际: ${a}`);
}

function ok(label, cond) {
  if (cond) pass++;
  else fails.push(label);
}

// ───────────── 1. 请求：responses → chat ─────────────

{
  const { payload } = responsesToChat({
    model: 'o3',
    input: 'hello',
    instructions: 'be brief',
    max_output_tokens: 100,
  });
  check('字符串 input → user 消息', payload.messages.at(-1), { role: 'user', content: 'hello' });
  check('instructions → system', payload.messages[0], { role: 'system', content: 'be brief' });
  check('max_output_tokens → max_tokens', payload.max_tokens, 100);
  check('model 透传', payload.model, 'o3');
}

{
  // 消息数组 + function_call + function_call_output（Codex 的典型工具往返）
  const { payload } = responsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do it' }] },
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"p":"a"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'file body' },
    ],
  });
  const msgs = payload.messages;
  check('developer → system', msgs[0].role, 'system');
  check('system 内容', msgs[0].content, 'sys');
  check('user 内容', msgs[1].content, 'do it');
  check('function_call → assistant.tool_calls', msgs[2].tool_calls[0].function.name, 'read_file');
  check('tool_call id', msgs[2].tool_calls[0].id, 'c1');
  check('function_call_output → tool 消息', msgs[3].role, 'tool');
  check('tool 消息内容', msgs[3].content, 'file body');
  check('tool_call_id 对应', msgs[3].tool_call_id, 'c1');
}

{
  // 工具定义：responses 扁平 → chat 嵌套
  const { payload } = responsesToChat({
    model: 'm',
    input: 'x',
    tools: [{ type: 'function', name: 'f1', description: 'd', parameters: { type: 'object' } }],
    reasoning: { effort: 'high' },
    stream: true,
  });
  check('工具包成 function', payload.tools[0].function.name, 'f1');
  check('reasoning.effort → reasoning_effort', payload.reasoning_effort, 'high');
  const conv = responsesToChat({ model: 'm', input: 'x', stream: true });
  check('stream 标记', conv.stream, true);
}

{
  // 图片输入：input_image → image_url
  const { payload } = responsesToChat({
    model: 'm',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this' },
          { type: 'input_image', image_url: 'https://x/a.png' },
        ],
      },
    ],
  });
  const content = payload.messages[0].content;
  ok('多模态保留为数组', Array.isArray(content));
  check('image_url 结构', content[1], { type: 'image_url', image_url: { url: 'https://x/a.png' } });
}

// ───────────── 2. 响应：chat → responses ─────────────

{
  const resp = chatToResponses(
    {
      choices: [{ message: { role: 'assistant', content: 'hi there' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    'gpt-5',
  );
  check('object=response', resp.object, 'response');
  check('status=completed', resp.status, 'completed');
  check('output_text', resp.output_text, 'hi there');
  check('output[0].type', resp.output[0].type, 'message');
  check('output[0].content[0].text', resp.output[0].content[0].text, 'hi there');
  check('usage 映射', resp.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  check('model 保留', resp.model, 'gpt-5');
}

{
  // 工具调用响应
  const resp = chatToResponses(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c9', type: 'function', function: { name: 'grep', arguments: '{"q":"x"}' } }],
          },
        },
      ],
    },
    'm',
  );
  const fc = resp.output.find((o) => o.type === 'function_call');
  ok('有 function_call 输出', !!fc);
  check('function_call name', fc.name, 'grep');
  check('function_call call_id', fc.call_id, 'c9');
  check('function_call arguments', fc.arguments, '{"q":"x"}');
}

{
  // reasoning_content 单独返回时，转成 reasoning 项
  const resp = chatToResponses(
    { choices: [{ message: { content: 'ok', reasoning_content: 'thinking...' } }] },
    'm',
  );
  const rs = resp.output.find((o) => o.type === 'reasoning');
  ok('有 reasoning 项', !!rs);
  check('reasoning 文本', rs.summary[0].text, 'thinking...');
}

// ───────────── 3. 流式：chat delta → responses 事件 ─────────────

{
  const s = new ChatToResponsesStreamer('m');
  let out = s.start();
  ok('start 发 response.created', out.includes('response.created'));
  ok('start 发 output_item.added', out.includes('response.output_item.added'));

  out = s.feed({ choices: [{ delta: { content: 'He' } }] });
  ok('正文增量事件', out.includes('response.output_text.delta'));
  s.feed({ choices: [{ delta: { content: 'llo' } }] });

  out = s.end({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  ok('结束发 output_text.done', out.includes('response.output_text.done'));
  ok('结束发 response.completed', out.includes('response.completed'));
  ok('累计文本正确', out.includes('Hello'));
  ok('usage 带出', out.includes('"total_tokens":5'));
}

{
  // 流式工具调用：分片 arguments 要拼接完整
  const s = new ChatToResponsesStreamer('m');
  s.start();
  s.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a"' } }] } }] });
  s.feed({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] });
  const out = s.end();
  ok('工具调用收尾事件', out.includes('response.output_item.done'));
  ok('arguments 拼接完整', out.includes('{"a":1}') || out.includes('{\\"a\\":1}'));
}

// ───────────── 结果 ─────────────

console.log(`\nresponses 协议转换: ${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ''}`);
if (fails.length) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
