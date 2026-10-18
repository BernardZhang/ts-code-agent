import { z } from 'zod';
import {
  EMessageRole,
  ToolExecutor,
  ToolRegistry,
  type ModelMessage,
  type ModelRequest,
  type ToolDefinition,
} from '@ts-code-agent/core';
import type { Config } from '../config.js';
import { bootstrap } from '../bootstrap.js';

const addInputSchema = z.object({
  a: z.number(),
  b: z.number(),
});

type AddInput = z.infer<typeof addInputSchema>;

const addTool: ToolDefinition<AddInput, number> = {
  name: 'add',
  description: '计算两个数字之和',
  inputSchema: addInputSchema,
  parameters: z.toJSONSchema(addInputSchema),
  execute: async (input: AddInput) => {
    return input.a + input.b;
  },
};

export async function toolsDemo(
  prompt: string,
  config: Config,
  signal: AbortSignal,
) {
  const { request, provider } = bootstrap(config, signal);

  // 注册工具
  const registry = new ToolRegistry();

  registry.register(addTool);

  // 请求参数
  const modelRequest: ModelRequest = {
    ...request,
    messages: [
      {
        role: EMessageRole.USER,
        content: prompt || '请调用 add 工具计算 12 加 30。',
      },
    ],
    tools: registry.list(),
  };

  // 调用模型生成
  const first = await provider.generate(modelRequest);

  // 下一步：检查工具调用，再执行
  const toolCalls = first.toolCalls;
  const toolExecutor = new ToolExecutor(registry);

  if (toolCalls === undefined || toolCalls.length === 0) {
    throw new Error('模型未返回工具调用');
  }

  const messages: ModelMessage[] = [
    ...modelRequest.messages,
    {
      role: EMessageRole.ASSISTANT,
      content: first.text,
      toolCalls,
    },
  ];

  // process.stdout.write(`${JSON.stringify(first)}\n`);

  // 循环异步调用工具
  for (const toolCall of toolCalls) {
    const result = await toolExecutor.execute(
      toolCall.name,
      toolCall.arguments,
      { signal },
    );
    messages.push({
      role: EMessageRole.TOOL,
      name: toolCall.name,
      content: JSON.stringify(result),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }

  // 调用完工具后，再次调用模型生成最终回答
  const final = await provider.generate({
    ...modelRequest,
    messages,
  });

  if (final.toolCalls?.length) {
    throw new Error('模型再次请求工具调用，超出本示例的一轮执行范围');
  }

  process.stdout.write(`${final.text}\n`);
}
