import { ContextError, type EContextErrorCode } from '../context/errors.js';
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
import { ToolErrorCode } from '../tools/result.js';

export enum EToolExecution {
  SEQUENTIAL = 'sequential',
  PARALLEL = 'parallel',
}

export enum EAgentEventType {
  RUN_STARTED = 'run.started',
  MODEL_STARTED = 'model.started',
  TEXT_DELTA = 'text.delta',
  MODEL_FINISHED = 'model.finished',
  TOOL_CALL_READY = 'tool.call.ready',
  TOOL_CALL_STARTED = 'tool.call.started',
  TOOL_CALL_FINISHED = 'tool.call.finished',
  RUN_FINISHED = 'run.finished',
}

export enum EAgentRunFailure {
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

type ToolCallEventFields = {
  step: number;
  toolCallId: string;
  toolName: string;
};
type AgentEventData =
  | { type: EAgentEventType.RUN_STARTED }
  | { type: EAgentEventType.MODEL_STARTED; step: number }
  | { type: EAgentEventType.TEXT_DELTA; step: number; text: string }
  | {
      type: EAgentEventType.MODEL_FINISHED;
      step: number;
      usage: ModelUsage;
      finishReason?: string;
    }
  | (ToolCallEventFields & { type: EAgentEventType.TOOL_CALL_READY })
  | (ToolCallEventFields & { type: EAgentEventType.TOOL_CALL_STARTED })
  | (ToolCallEventFields & {
      type: EAgentEventType.TOOL_CALL_FINISHED;
    } & ({ success: true } | { success: false; errorCode: ToolErrorCode }))
  | {
      type: EAgentEventType.RUN_FINISHED;
      steps: number;
      status: EAgentStatus | EAgentRunFailure;
      errorCode?: ModelErrorCode | EContextErrorCode;
    };

export type AgentEvent = AgentEventData & { runId: string; elapsedMs: number };
type EmitAgentEvent = (event: AgentEventData) => void;

export interface AgentRunOptions {
  /** Optional externally allocated correlation ID, shared with trace initialization. */
  runId?: string;
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
    const { maxSteps, onEvent } = options;
    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
      throw new Error('maxSteps 必须是正的安全整数');
    }

    const signal = options.request.signal ?? new AbortController().signal;
    const runId = options.runId ?? crypto.randomUUID();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
      throw new RangeError('runId 必须为1到128位字母、数字、下划线或连字符');
    }
    const startedAt = performance.now();
    let steps = 0;
    const emit: EmitAgentEvent = (event) => {
      if (event.type === EAgentEventType.MODEL_STARTED) {
        steps = event.step;
      }
      onEvent?.({ ...event, runId, elapsedMs: performance.now() - startedAt });
    };

    let result: AgentResult;
    try {
      emit({ type: EAgentEventType.RUN_STARTED });
      result = await this.runLoop(options, signal, emit);
    } catch (error) {
      const errorCode =
        error instanceof ModelError || error instanceof ContextError
          ? error.code
          : undefined;
      emit({
        type: EAgentEventType.RUN_FINISHED,
        steps,
        status:
          signal.aborted || errorCode === ModelErrorCode.CANCELLED
            ? EAgentRunFailure.CANCELLED
            : EAgentRunFailure.FAILED,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
      throw error;
    }
    emit({
      type: EAgentEventType.RUN_FINISHED,
      steps: result.steps,
      status: result.status,
    });
    return result;
  }

  private async runLoop(
    options: AgentRunOptions,
    signal: AbortSignal,
    emit: EmitAgentEvent,
  ): Promise<AgentResult> {
    const request: ModelRequest = {
      ...options.request,
      signal,
      messages: [...options.request.messages],
    };

    // loop 限制最大访问模型次数maxSteps
    for (let step = 1; step <= options.maxSteps; step++) {
      signal.throwIfAborted();
      const contextMessages =
        options.contextManager?.buildContext(request.messages) ??
        request.messages;
      emit({ type: EAgentEventType.MODEL_STARTED, step });
      signal.throwIfAborted();
      const modelResult = await this.generateResponse(
        {
          ...request,
          messages: contextMessages,
        },
        options.stream,
        step,
        emit,
      );
      const toolCalls = modelResult.toolCalls;

      signal.throwIfAborted();

      // 一次模型请求已完整消费；这不代表 Agent 任务已经结束。
      emit({
        type: EAgentEventType.MODEL_FINISHED,
        step,
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
          steps: step,
          result: modelResult,
          messages: request.messages,
        };
      }

      const calls = toolCalls.map((tool, index) => ({
        tool,
        fields: {
          step,
          toolCallId: `${step}:${index + 1}`,
          toolName: tool.name,
        },
      }));
      for (const { fields } of calls) {
        signal.throwIfAborted();
        emit({ type: EAgentEventType.TOOL_CALL_READY, ...fields });
      }

      const executeTool = async ({ tool, fields }: (typeof calls)[number]) => {
        signal.throwIfAborted();
        emit({ type: EAgentEventType.TOOL_CALL_STARTED, ...fields });
        let result;
        let content: string;
        try {
          result = await this.toolExecutor.execute(tool.name, tool.arguments, {
            signal,
          });
          content = JSON.stringify(result, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString(10) : value,
          );
        } catch (error) {
          emit({
            type: EAgentEventType.TOOL_CALL_FINISHED,
            ...fields,
            success: false,
            errorCode: signal.aborted
              ? ToolErrorCode.CANCELLED
              : ToolErrorCode.EXECUTION_FAILED,
          });
          throw error;
        }
        emit({
          type: EAgentEventType.TOOL_CALL_FINISHED,
          ...fields,
          ...(result.success
            ? { success: true }
            : { success: false, errorCode: result.error.code }),
        });
        return {
          role: EMessageRole.TOOL,
          name: tool.name,
          content,
        } satisfies ModelMessage;
      };

      if (options.toolExecution === EToolExecution.PARALLEL) {
        // 等待已启动调用结束，再发出 run 终态；消息仍按调用顺序保存。
        const results = await Promise.allSettled(calls.map(executeTool));
        for (const result of results) {
          if (result.status === 'rejected') {
            throw result.reason;
          }
          request.messages.push(result.value);
        }
        signal.throwIfAborted();
      } else {
        for (const call of calls) {
          request.messages.push(await executeTool(call));
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
    stream: boolean | undefined,
    step: number,
    emit: EmitAgentEvent,
  ): Promise<ModelResult> {
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
          emit({
            type: EAgentEventType.TEXT_DELTA,
            step,
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
