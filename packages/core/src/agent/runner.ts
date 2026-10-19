import { EMessageRole, type ModelMessage } from '../model/messages.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
} from '../model/provider.js';
import type { ToolExecutor } from '../tools/executor.js';

export interface AgentRunOptions {
  request: ModelRequest;
  maxSteps: number;
}

export enum EAgentStatus {
  COMPLETE = 'complete',
  MAX_STEPS = 'max_steps',
}

export type AgentResult =
  | {
      status: EAgentStatus.COMPLETE;
      result: ModelResult;
      steps: number;
      messages: ModelMessage[];
    }
  | {
      status: EAgentStatus.MAX_STEPS;
      steps: number;
      messages: ModelMessage[];
    };

export class AgentRunner {
  constructor(
    private readonly provider: ModelProvider,
    private readonly toolExecutor: ToolExecutor,
  ) {}

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const signal = options.request.signal ?? new AbortController().signal;

    signal.throwIfAborted();

    const request: ModelRequest = {
      ...options.request,
      signal,
      messages: [...options.request.messages],
    };
    const maxSteps = options.maxSteps;

    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
      throw new Error('maxSteps 必须是正的安全整数');
    }

    // loop 限制最大访问模型次数maxSteps
    for (let step = 0; step < options.maxSteps; step++) {
      const modelResult = await this.provider.generate(request);
      const toolCalls = modelResult.toolCalls;

      signal.throwIfAborted();

      request.messages.push({
        role: EMessageRole.ASSISTANT,
        content: modelResult.text,
        ...(toolCalls?.length ? { toolCalls } : {}),
      });

      // 判断是否结束（有工具则继续执行工具，否则结束返回模型结果）
      if (!toolCalls?.length) {
        return {
          status: EAgentStatus.COMPLETE,
          steps: step + 1,
          result: modelResult,
          messages: request.messages,
        };
      }

      // 循环执行工具
      for (const tool of toolCalls) {
        const toolResult = await this.toolExecutor.execute(
          tool.name,
          tool.arguments,
          { signal },
        );

        // 工具调用完成后（成功或失败），将工具调用及工具执行结果放入到messages中
        request.messages.push({
          role: EMessageRole.TOOL,
          name: tool.name,
          content: JSON.stringify(toolResult),
        });

        signal.throwIfAborted();
      }
    }

    // 超出最大轮次限制
    return {
      status: EAgentStatus.MAX_STEPS,
      steps: options.maxSteps,
      messages: request.messages,
    };
  }
}
