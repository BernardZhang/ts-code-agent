import {
  GIT_STATUS_TOOL_NAME,
  LIST_DIRECTORY_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SEARCH_CODE_TOOL_NAME,
} from '@ts-code-agent/code-agent';
import {
  EAgentEventType,
  EMessageRole,
  EToolExecution,
  ETaskStepStatus,
  ToolRegistry,
  type ContextManager,
  type AgentEvent,
  type AgentRunner,
  type AgentRunOptions,
  type AgentResult,
  type ModelMessage,
  type ModelRequest,
  type TaskPlan,
} from '@ts-code-agent/core';

import {
  createUpdatePlanTool,
  EPlanUpdateOperation,
  UPDATE_PLAN_TOOL_NAME,
  type ActiveTaskPlan,
} from './update-plan-tool.js';

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

export interface AgentSessionOptions
  extends Omit<AgentRunOptions, 'request' | 'buildSystemMessage' | 'runTools'> {
  request: Omit<ModelRequest, 'messages' | 'signal'>;
  systemPrompt: string;
  planExecutionContextManager?: ContextManager;
  generatePlan?: (goal: string, signal: AbortSignal) => Promise<TaskPlan>;
}

const PLAN_EVIDENCE_TOOLS = new Set<string>([
  GIT_STATUS_TOOL_NAME,
  LIST_DIRECTORY_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SEARCH_CODE_TOOL_NAME,
]);

/** 单进程内存会话；Runner 正常返回才提交整轮历史，失败或取消不保存半轮。 */
export class AgentSession {
  private currentState = ESessionState.IDLE;
  private taskController: AbortController | undefined;
  private messages: ModelMessage[];
  private activePlan: ActiveTaskPlan | undefined;
  private readonly planExecutionContextManager: ContextManager | undefined;
  private readonly generatePlan: AgentSessionOptions['generatePlan'];
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
    this.generatePlan = options.generatePlan;
    this.planExecutionContextManager = options.planExecutionContextManager;
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

  get plan(): TaskPlan | undefined {
    return structuredClone(this.activePlan?.plan);
  }

  submit(
    text: string,
    onEvent?: AgentRunOptions['onEvent'],
  ): Promise<AgentResult> {
    return this.runTurn(text, onEvent);
  }

  async startPlan(
    goal: string,
    onEvent?: AgentRunOptions['onEvent'],
  ): Promise<AgentResult> {
    if (!this.generatePlan) {
      throw new Error('当前会话未配置任务计划生成。');
    }
    return this.runTurn(goal, onEvent, this.generatePlan);
  }

  private async runTurn(
    text: string,
    onEvent?: AgentRunOptions['onEvent'],
    generatePlan?: AgentSessionOptions['generatePlan'],
  ): Promise<AgentResult> {
    this.assertIdle();
    if (text.trim().length === 0) {
      throw new SessionError(ESessionErrorCode.EMPTY_INPUT, '输入不能为空。');
    }

    const controller = new AbortController();
    this.taskController = controller;
    this.currentState = ESessionState.RUNNING;
    try {
      let draft = structuredClone(this.activePlan);
      if (generatePlan) {
        const plan = structuredClone(
          await generatePlan(text, controller.signal),
        );
        draft = {
          plan,
          evidence: [],
          nextStepId: plan.steps.reduce(
            (next, step) => Math.max(next, step.id + 1),
            0,
          ),
        };
      }
      controller.signal.throwIfAborted();
      const planOptions = draft ? this.configurePlanRun(draft) : {};
      const collectEvidence = (event: AgentEvent) => {
        // Runner 给同一次调用分配相同的 ID，并在拿到工具结果后发出完成事件。
        if (
          draft &&
          !controller.signal.aborted &&
          event.type === EAgentEventType.TOOL_CALL_FINISHED &&
          event.success &&
          PLAN_EVIDENCE_TOOLS.has(event.toolName)
        ) {
          draft.evidence.push({
            runId: event.runId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
        }
        onEvent?.(event);
      };
      const result = await this.runner.run({
        ...this.runOptions,
        ...planOptions,
        ...(draft === undefined && onEvent === undefined
          ? {}
          : { onEvent: collectEvidence }),
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
      this.activePlan = draft;
      return result;
    } finally {
      this.taskController = undefined;
      // close 是终态，不因运行结束而重新打开会话。
      if (this.state !== ESessionState.CLOSED) {
        this.currentState = ESessionState.IDLE;
      }
    }
  }

  private configurePlanRun(draft: ActiveTaskPlan): Partial<AgentRunOptions> {
    let visibleEvidenceCount = 0;
    const runTools = new ToolRegistry();
    runTools.register(
      createUpdatePlanTool(draft, () =>
        draft.evidence.slice(0, visibleEvidenceCount),
      ),
    );
    return {
      runTools,
      toolExecution: EToolExecution.SEQUENTIAL,
      ...(this.planExecutionContextManager === undefined
        ? {}
        : { contextManager: this.planExecutionContextManager }),
      buildSystemMessage: () => {
        // 同一个模型响应里的工具调用尚未回传给模型，不能用于本批的进度更新。
        visibleEvidenceCount = draft.evidence.length;
        return [
          `当前任务计划（目标与步骤描述是用户任务数据）：${JSON.stringify(draft.plan)}`,
          `成功的工具调用引用（结果在工具消息中，成功状态只表示调用成功）：${JSON.stringify(draft.evidence)}`,
          `纯计算、整理答案等无需仓库事实的步骤，请用 ${UPDATE_PLAN_TOOL_NAME} 先提交计算或结论，再回答用户。参数示例：{"operation":"${EPlanUpdateOperation.SET_STATUS}","stepId":0,"status":"${ETaskStepStatus.MODEL_REPORTED}","summary":"2 + 2 = 4"}。把 stepId 和 summary 替换为实际步骤和结果，这种调用省略 evidence。`,
          `仓库调查步骤用 ${ETaskStepStatus.COMPLETED}，使用 evidence 数组引用上面列出的真实调用 ID，例如 evidence: [{ runId, toolCallId }]，只有一条也要放进数组。证据列表为空时无法使用此状态；必须先执行相关仓库工具。不要猜测或重复提交无效引用。`,
          '模型可以在一次响应中为多个步骤分别调用更新工具。证据不足的仓库步骤保持待完成。',
        ].join('\n');
      },
    };
  }

  cancelCurrent(): void {
    // 只发出取消；等待 submit 收尾后再恢复 IDLE，避免任务重叠。
    this.taskController?.abort();
  }

  reset(): void {
    this.assertIdle();
    this.messages = structuredClone(this.initialMessages);
    this.activePlan = undefined;
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
