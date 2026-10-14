import { ModelError } from '@ts-code-agent/core';
import { z } from 'zod';
import { bootstrap } from '../bootstrap.js';
import type { Config } from '../config.js';

export const planSchema = z
  .object({
    task: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
  })
  .strict();

export function parsePlan(text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ModelError('json', '模型输出不是合法 JSON。', { cause });
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success)
    throw new ModelError('validation', '模型 JSON 不符合任务规划 Schema。', {
      cause: parsed.error,
    });
  return parsed.data;
}

export async function structuredDemo(config: Config, signal: AbortSignal) {
  const { provider, request } = bootstrap(config, signal);
  if (!provider.capabilities.structuredOutput)
    throw new ModelError('unsupported', 'Provider 不支持结构化输出。');
  const result = await provider.generate({
    ...request,
    messages: [
      {
        role: 'user',
        content:
          '返回一个 JSON 对象：task 为学习 Agent Loop，steps 为三个学习步骤。',
      },
    ],
    jsonSchema: z.toJSONSchema(planSchema),
  });
  process.stdout.write(`${JSON.stringify(parsePlan(result.text), null, 2)}\n`);
}
