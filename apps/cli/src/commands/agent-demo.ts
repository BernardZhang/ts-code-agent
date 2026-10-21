import {
  estimateMessageTokens,
  estimateToolDefinitionTokens,
} from '@ts-code-agent/adapters';
import { z } from 'zod';
import {
  AgentRunner,
  ContextManager,
  EAgentStatus,
  EMessageRole,
  ToolExecutor,
  ToolRegistry,
  type ModelRequest,
  type ToolDefinition,
} from '@ts-code-agent/core';
import type { Config } from '../config.js';
import { bootstrap } from '../bootstrap.js';

const RESERVED_OUTPUT_TOKENS = 1024;

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

export async function agentDemo(
  prompt: string,
  config: Config,
  signal: AbortSignal,
) {
  const { request, provider } = bootstrap(config, signal);

  // 注册工具
  const registry = new ToolRegistry();
  const toolExecutor = new ToolExecutor(registry);

  registry.register(addTool);

  const tools = registry.list();
  const contextManager = new ContextManager(
    {
      contextWindow: config.contextLength,
      reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
      toolDefinitionTokens: estimateToolDefinitionTokens(tools),
    },
    estimateMessageTokens,
  );

  // 请求参数
  const modelRequest: ModelRequest = {
    ...request,
    messages: [
      {
        role: EMessageRole.SYSTEM,
        content: [
          '你是一个计算助手。',
          '数值加法必须调用 add 工具，以工具结果为依据回答。',
          '遇到未赋值变量时，不得猜测变量值。',
          '含未知变量时，先通过工具完成所有可确定的数值加法，将表达式化简后再询问未知变量值；例如 1 + 2 + x 应化简为 3 + x。',
          '可以化简已知部分，保留未知变量，并向用户询问其值。',
        ].join('\n'),
      },
      {
        role: EMessageRole.USER,
        content: prompt,
      },
    ],
    tools,
  };

  const agentRunner = new AgentRunner(provider, toolExecutor);

  process.stderr.write(
    '上下文使用 UTF-8 字节数启发式 token 估算，非精确计数，不保证不超限。\n',
  );

  const agentResult = await agentRunner.run({
    request: modelRequest,
    maxSteps: 10,
    contextManager,
  });

  const toolCalls = agentResult.messages.flatMap((message) =>
    message.role === EMessageRole.ASSISTANT ? (message.toolCalls ?? []) : [],
  );

  process.stderr.write(
    `模型请求 ${agentResult.steps} 次，工具调用 ${toolCalls.length} 次。\n`,
  );

  if (agentResult.status === EAgentStatus.COMPLETE) {
    process.stdout.write(`${agentResult.result.text}\n`);
  } else {
    process.stderr.write(
      `已达到最大模型请求次数（${agentResult.steps}），任务尚未完成。\n`,
    );
    process.exitCode = 1;
  }
}
