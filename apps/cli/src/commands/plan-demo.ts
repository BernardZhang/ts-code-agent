import { ModelErrorCode } from '@ts-code-agent/core';
import {
  EMessageRole,
  ETaskStepStatus,
  ModelError,
  type ContextManager,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
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
    throw new ModelError(ModelErrorCode.JSON, '模型输出不是合法 JSON。', {
      cause,
    });
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ModelError(
      ModelErrorCode.VALIDATION,
      '模型 JSON 不符合任务规划 Schema。',
      {
        cause: parsed.error,
      },
    );
  }

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

export async function generateTaskPlan(
  provider: ModelProvider,
  request: Omit<ModelRequest, 'messages' | 'tools' | 'jsonSchema'>,
  goal: string,
  contextManager?: ContextManager,
): Promise<TaskPlan> {
  request.signal?.throwIfAborted();
  if (!provider.capabilities.structuredOutput) {
    throw new ModelError(
      ModelErrorCode.UNSUPPORTED,
      'Provider 不支持结构化输出。',
    );
  }
  const messages: ModelMessage[] = [
    {
      role: EMessageRole.SYSTEM,
      content:
        '将用户任务拆解为可执行计划。返回 JSON：goal 为任务目标，steps 为非空步骤说明数组。只生成计划，不执行任务。',
    },
    { role: EMessageRole.USER, content: goal },
  ];
  const jsonSchema = z.toJSONSchema(planSchema);
  // 结构化输出的 Schema 随请求发送，也计入规划请求预算。
  contextManager?.buildContext([
    ...messages,
    { role: EMessageRole.SYSTEM, content: JSON.stringify(jsonSchema) },
  ]);
  const result = await provider.generate({ ...request, messages, jsonSchema });
  request.signal?.throwIfAborted();
  return parseTaskPlan(result.text);
}

export async function planDemo(
  prompt: string,
  config: Config,
  signal: AbortSignal,
) {
  const { provider, request } = bootstrap(config, signal);
  const plan = await generateTaskPlan(provider, request, prompt);
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
