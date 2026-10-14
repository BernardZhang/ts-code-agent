import { OllamaProvider } from '@ts-code-agent/adapters';
import { z } from 'zod';
import { planSchema, parsePlan } from '../src/commands/structured-demo.js';

const baseUrl = process.env.AGENT_BASE_URL ?? 'http://127.0.0.1:11434';
const model = process.env.AGENT_MODEL ?? 'qwen3:8b';
const version: unknown = await (await fetch(`${baseUrl}/api/version`)).json();
const models: unknown = await (await fetch(`${baseUrl}/api/tags`)).json();
console.log(
  JSON.stringify(
    { version, models, model, contextLength: 8192, think: false },
    null,
    2,
  ),
);
const provider = new OllamaProvider({ baseUrl, timeoutMs: 120_000 });
const input = {
  model,
  messages: [{ role: 'user' as const, content: '仅回复：你好' }],
  contextLength: 8192,
  think: false,
};
let streamed = '';
let completed = false;
for await (const event of provider.stream(input)) {
  if (event.type === 'text.delta') streamed += event.text;
  if (event.type === 'done') completed = true;
}
if (!completed || !streamed.trim()) throw new Error('流式响应验收失败。');
const structured = await provider.generate({
  ...input,
  messages: [
    {
      role: 'user',
      content: '返回 JSON：task 为学习 Agent，steps 为三个学习步骤。',
    },
  ],
  jsonSchema: z.toJSONSchema(planSchema),
});
console.log(
  JSON.stringify({ streamed, structured: parsePlan(structured.text) }, null, 2),
);
const start = performance.now();
const result = await provider.generate({
  model,
  messages: [{ role: 'user', content: '仅回复：你好' }],
  contextLength: 8192,
  think: false,
});
console.log(
  JSON.stringify({ result, elapsedMs: performance.now() - start }, null, 2),
);
