import {
  EMessageRole,
  ETaskStepStatus,
  ModelError,
  type TaskPlan,
  TaskPlanner,
} from '@ts-code-agent/core';
import { z } from 'zod';
import { bootstrap } from '../bootstrap.js';
import type { Config } from '../config.js';

export const planSchema = z
  .object({
    goal: z.string().trim().min(1),
    steps: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export function parseTaskPlan(text: string): TaskPlan {
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

  const taskPlanner = new TaskPlanner();

  return taskPlanner.createPlan(
    parsed.data.goal,
    parsed.data.steps.map((step, index) => ({
      id: index,
      description: step,
      status: ETaskStepStatus.PENDING,
    })),
  );
}

export async function planDemo(
  prompt: string,
  config: Config,
  signal: AbortSignal,
) {
  const { provider, request } = bootstrap(config, signal);
  if (!provider.capabilities.structuredOutput)
    throw new ModelError('unsupported', 'Provider 不支持结构化输出。');
  const result = await provider.generate({
    ...request,
    messages: [
      {
        role: EMessageRole.SYSTEM,
        content:
          '将用户任务拆解为可执行计划。返回 JSON：goal 为任务目标，steps 为非空步骤说明数组。只生成计划，不执行任务。',
      },
      {
        role: EMessageRole.USER,
        content: prompt,
      },
    ],
    jsonSchema: z.toJSONSchema(planSchema),
  });

  process.stdout.write(
    `${JSON.stringify(parseTaskPlan(result.text), null, 2)}\n`,
  );
}
