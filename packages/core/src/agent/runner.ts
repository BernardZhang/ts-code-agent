import type { ContextManager } from '../context/manager.js';
import { ModelError, ModelErrorCode } from '../model/errors.js';
import { EModelEventType, type ModelUsage } from '../model/events.js';
import { EMessageRole, type ModelMessage } from '../model/messages.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
} from '../model/provider.js';
import type { ToolExecutor } from '../tools/executor.js';

export enum EToolExecution {
  SEQUENTIAL = 'sequential',
  PARALLEL = 'parallel',
}

export enum EAgentEventType {
  TEXT_DELTA = 'text.delta',
  MODEL_FINISHED = 'model.finished',
}

export type AgentEvent =
  | { type: EAgentEventType.TEXT_DELTA; text: string }
  | {
      type: EAgentEventType.MODEL_FINISHED;
      step: number;
      usage: ModelUsage;
      finishReason?: string;
    };

export interface AgentRunOptions {
  request: ModelRequest;
  maxSteps: number;
  toolExecution?: EToolExecution;
  contextManager?: ContextManager;

  stream?: boolean;
  onEvent?: (event: AgentEvent) => void;
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
      signal.throwIfAborted();
      const contextMessages =
        options.contextManager?.buildContext(request.messages) ??
        request.messages;
      const modelResult = await this.generateResponse(
        {
          ...request,
          messages: contextMessages,
        },
        options,
      );
      const toolCalls = modelResult.toolCalls;

      signal.throwIfAborted();

      // 一次模型请求已完整消费；这不代表 Agent 任务已经结束。
      options.onEvent?.({
        type: EAgentEventType.MODEL_FINISHED,
        step: step + 1,
        usage: { ...modelResult.usage },
        ...(modelResult.finishReason === undefined
          ? {}
          : { finishReason: modelResult.finishReason }),
      });

      // 同步事件订阅方也可能取消任务，不再追加消息或执行工具。
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

      const executeTool = async (tool: (typeof toolCalls)[number]) => {
        signal.throwIfAborted();
        const result = await this.toolExecutor.execute(
          tool.name,
          tool.arguments,
          { signal },
        );
        return {
          role: EMessageRole.TOOL,
          name: tool.name,
          content: JSON.stringify(result),
        } satisfies ModelMessage;
      };

      if (options.toolExecution === EToolExecution.PARALLEL) {
        // Promise.all 保留调用顺序；全部结果就绪后才进入下一次模型请求。
        const results = await Promise.all(toolCalls.map(executeTool));
        request.messages.push(...results);
        signal.throwIfAborted();
      } else {
        for (const tool of toolCalls) {
          request.messages.push(await executeTool(tool));
          signal.throwIfAborted();
        }
      }
    }

    // 超出最大轮次限制
    return {
      status: EAgentStatus.MAX_STEPS,
      steps: options.maxSteps,
      messages: request.messages,
    };
  }

  private async generateResponse(
    request: ModelRequest,
    options: AgentRunOptions,
  ): Promise<ModelResult> {
    const { stream, onEvent } = options;

    if (!stream) {
      return await this.provider.generate(request);
    }

    let result: ModelResult | undefined;

    for await (const event of this.provider.stream(request)) {
      request.signal?.throwIfAborted();

      // DONE后再收到事件，属于协议异常
      if (result) {
        throw new ModelError(
          ModelErrorCode.PROTOCOL,
          '模型流式事件协议异常：DONE 后仍收到事件。',
        );
      }

      switch (event.type) {
        case EModelEventType.TEXT_DELTA:
          onEvent?.({
            type: EAgentEventType.TEXT_DELTA,
            text: event.text,
          });
          break;
        case EModelEventType.DONE: {
          result = event.result;
          break;
        }
      }
    }

    // 最后一次 next() 可能在取消后直接结束，不会进入循环体。
    request.signal?.throwIfAborted();

    if (!result) {
      throw new ModelError(
        ModelErrorCode.PROTOCOL,
        '模型流式事件协议异常：未收到 DONE 事件。',
      );
    }

    return result;
  }
}
