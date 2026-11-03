import {
  EMessageRole,
  type AgentRunner,
  type AgentRunOptions,
  type AgentResult,
  type ModelMessage,
  type ModelRequest,
} from '@ts-code-agent/core';

export enum ESessionState {
  IDLE = 'idle',
  RUNNING = 'running',
  CLOSED = 'closed',
}

export enum ESessionErrorCode {
  EMPTY_INPUT = 'session_empty_input',
  BUSY = 'session_busy',
  CLOSED = 'session_closed',
}

export class SessionError extends Error {
  constructor(
    public readonly code: ESessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export interface AgentSessionOptions extends Omit<AgentRunOptions, 'request'> {
  request: Omit<ModelRequest, 'messages' | 'signal'>;
  systemPrompt: string;
}

/** 单进程内存会话；Runner 正常返回才提交整轮历史，失败或取消不保存半轮。 */
export class AgentSession {
  private currentState = ESessionState.IDLE;
  private taskController: AbortController | undefined;
  private messages: ModelMessage[];
  private readonly initialMessages: ModelMessage[];
  private readonly request: AgentSessionOptions['request'];
  private readonly runOptions: Omit<AgentRunOptions, 'request'>;

  constructor(
    private readonly runner: Pick<AgentRunner, 'run'>,
    options: AgentSessionOptions,
  ) {
    if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps <= 0) {
      throw new RangeError('maxSteps 必须是正的安全整数。');
    }
    this.initialMessages = [
      { role: EMessageRole.SYSTEM, content: options.systemPrompt },
    ];
    this.messages = structuredClone(this.initialMessages);
    // 模型请求和消息都是可序列化 DTO；复制后不共享调用方的可变配置。
    this.request = structuredClone(options.request);
    this.runOptions = {
      maxSteps: options.maxSteps,
      ...(options.stream === undefined ? {} : { stream: options.stream }),
      ...(options.contextManager === undefined
        ? {}
        : { contextManager: options.contextManager }),
      ...(options.toolExecution === undefined
        ? {}
        : { toolExecution: options.toolExecution }),
    };
  }

  get state(): ESessionState {
    return this.currentState;
  }

  /** 返回独立快照，防止显示层或调用方修改已确认的历史。 */
  get history(): ModelMessage[] {
    return structuredClone(this.messages);
  }

  get stream(): boolean | undefined {
    return this.runOptions.stream;
  }

  async submit(
    text: string,
    onEvent?: AgentSessionOptions['onEvent'],
  ): Promise<AgentResult> {
    this.assertIdle();
    if (text.trim().length === 0) {
      throw new SessionError(ESessionErrorCode.EMPTY_INPUT, '输入不能为空。');
    }

    const controller = new AbortController();
    this.taskController = controller;
    this.currentState = ESessionState.RUNNING;
    try {
      const result = await this.runner.run({
        ...this.runOptions,
        ...(onEvent === undefined ? {} : { onEvent }),
        request: {
          ...structuredClone(this.request),
          messages: [
            ...structuredClone(this.messages),
            { role: EMessageRole.USER, content: text },
          ],
          signal: controller.signal,
        },
      });
      // 即使底层没有及时响应取消，也不能把取消后的返回值提交进历史。
      controller.signal.throwIfAborted();
      // COMPLETE 和 MAX_STEPS 均包含完整工具结果；状态原样返回，不等同任务成功。
      this.messages = structuredClone(result.messages);
      return result;
    } finally {
      this.taskController = undefined;
      // close 是终态，不因运行结束而重新打开会话。
      if (this.state !== ESessionState.CLOSED) {
        this.currentState = ESessionState.IDLE;
      }
    }
  }

  cancelCurrent(): void {
    // 只发出取消；等待 submit 收尾后再恢复 IDLE，避免任务重叠。
    this.taskController?.abort();
  }

  reset(): void {
    this.assertIdle();
    this.messages = structuredClone(this.initialMessages);
  }

  close(): void {
    this.currentState = ESessionState.CLOSED;
    this.cancelCurrent();
  }

  private assertIdle(): void {
    if (this.currentState === ESessionState.CLOSED) {
      throw new SessionError(ESessionErrorCode.CLOSED, '会话已关闭。');
    }
    if (this.currentState === ESessionState.RUNNING) {
      throw new SessionError(ESessionErrorCode.BUSY, '当前任务尚未结束。');
    }
  }
}
