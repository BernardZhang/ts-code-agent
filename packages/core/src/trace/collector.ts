import {
  EAgentEventType,
  EAgentStatus,
  EAgentRunFailure,
  type AgentEvent,
} from '../agent/runner.js';
import { ModelErrorCode } from '../model/errors.js';
import { EContextErrorCode } from '../context/errors.js';
import { ToolErrorCode } from '../tools/result.js';
import {
  ETraceIssue,
  ETraceState,
  type TraceLimits,
  type TraceModel,
  type TraceRecord,
  type TraceSnapshot,
  type TraceSpan,
  type TraceTool,
} from './types.js';

const DEFAULT_LIMITS: TraceLimits = {
  maxModels: 1024,
  maxTools: 4096,
  maxIssues: 256,
};
const bytes = (value: string) => new TextEncoder().encode(value).length;
const validName = (value: string, max: number) =>
  typeof value === 'string' && value.length > 0 && bytes(value) <= max;
const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** 每个实例拥有一个run，只保存允许字段及有界摘要。 */
export class TraceCollector {
  private readonly models = new Map<number, TraceModel>();
  private readonly tools = new Map<string, TraceTool>();
  private readonly snapshot: TraceSnapshot;
  private readonly limits: TraceLimits;

  constructor(
    private readonly runId: string,
    limits: Partial<TraceLimits> = {},
  ) {
    if (!validName(runId, 128)) {
      throw new RangeError('无效runId');
    }
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (
      Object.values(this.limits).some(
        (limit) => !validCount(limit) || limit === 0,
      )
    ) {
      throw new RangeError('摘要上限必须是正安全整数');
    }
    this.snapshot = {
      runId,
      models: [],
      tools: [],
      receivedCount: 0,
      rejectedCount: 0,
      issueCount: 0,
      issues: [],
      summaryTruncated: false,
    };
  }

  record(event: AgentEvent): TraceRecord | undefined {
    const sequence = ++this.snapshot.receivedCount;
    if (!this.valid(event)) {
      this.snapshot.rejectedCount++;
      this.issue(ETraceIssue.INVALID_EVENT);
      return undefined;
    }
    const record = this.sanitize(event, sequence);
    if (this.snapshot.finishedAtMs !== undefined) {
      this.issue(ETraceIssue.AFTER_TERMINAL);
      return record;
    }
    switch (record.type) {
      case EAgentEventType.RUN_STARTED:
        if (this.snapshot.startedAtMs !== undefined) {
          this.issue(ETraceIssue.DUPLICATE_START);
        } else {
          this.snapshot.startedAtMs = record.elapsedMs;
        }
        break;
      case EAgentEventType.RUN_FINISHED:
        this.snapshot.finishedAtMs = record.elapsedMs;
        this.snapshot.status = record.status;
        for (const span of [...this.models.values(), ...this.tools.values()]) {
          if (span.state === ETraceState.READY) {
            span.state = ETraceState.NOT_EXECUTED;
          } else if (span.state === ETraceState.RUNNING) {
            span.state = ETraceState.INCOMPLETE;
          }
        }
        break;
      case EAgentEventType.MODEL_STARTED:
      case EAgentEventType.MODEL_FINISHED: {
        const span = this.model(record.step);
        if (span) {
          this.update(
            span,
            record.elapsedMs,
            record.type === EAgentEventType.MODEL_STARTED,
            true,
          );
        }
        break;
      }
      case EAgentEventType.TOOL_CALL_READY:
      case EAgentEventType.TOOL_CALL_STARTED:
      case EAgentEventType.TOOL_CALL_FINISHED: {
        const span = this.tool(record);
        if (!span) {
          break;
        }
        if (record.type === EAgentEventType.TOOL_CALL_READY) {
          if (span.readyAtMs === undefined) {
            span.readyAtMs = record.elapsedMs;
          } else {
            this.issue(ETraceIssue.DUPLICATE_START);
          }
        } else {
          const firstFinish = span.finishedAtMs === undefined;
          this.update(
            span,
            record.elapsedMs,
            record.type === EAgentEventType.TOOL_CALL_STARTED,
            record.type === EAgentEventType.TOOL_CALL_STARTED || record.success,
          );
          if (
            record.type === EAgentEventType.TOOL_CALL_FINISHED &&
            firstFinish &&
            !record.success
          ) {
            span.errorCode = record.errorCode;
          }
        }
        break;
      }
      case EAgentEventType.TEXT_DELTA:
        break;
    }
    return record;
  }

  getSnapshot(): TraceSnapshot {
    return structuredClone({
      ...this.snapshot,
      models: [...this.models.values()],
      tools: [...this.tools.values()],
    });
  }

  private issue(reason: ETraceIssue) {
    this.snapshot.issueCount++;
    if (this.snapshot.issues.length < this.limits.maxIssues) {
      this.snapshot.issues.push({
        sequence: this.snapshot.receivedCount,
        reason,
      });
    }
  }

  private model(step: number): TraceModel | undefined {
    const existing = this.models.get(step);
    if (existing) {
      return existing;
    }
    if (this.models.size >= this.limits.maxModels) {
      this.limit();
      return undefined;
    }
    const span: TraceModel = { step, state: ETraceState.READY };
    this.models.set(step, span);
    return span;
  }

  private tool(
    record: Extract<TraceRecord, { toolCallId: string }>,
  ): TraceTool | undefined {
    const existing = this.tools.get(record.toolCallId);
    if (existing) {
      if (
        existing.step !== record.step ||
        existing.toolName !== record.toolName
      ) {
        this.issue(ETraceIssue.INCONSISTENT_CALL);
        return undefined;
      }
      return existing;
    }
    if (this.tools.size >= this.limits.maxTools) {
      this.limit();
      return undefined;
    }
    const span: TraceTool = {
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      step: record.step,
      state: ETraceState.READY,
    };
    this.tools.set(record.toolCallId, span);
    return span;
  }

  private limit() {
    this.snapshot.summaryTruncated = true;
    this.issue(ETraceIssue.LIMIT);
  }

  private update(
    span: TraceSpan,
    time: number,
    start: boolean,
    success: boolean,
  ) {
    if (start) {
      if (span.finishedAtMs !== undefined) {
        this.issue(ETraceIssue.AFTER_TERMINAL);
        return;
      }
      if (span.startedAtMs !== undefined) {
        this.issue(ETraceIssue.DUPLICATE_START);
        return;
      }
      span.startedAtMs = time;
      span.state = ETraceState.RUNNING;
      return;
    }
    if (span.finishedAtMs !== undefined) {
      this.issue(ETraceIssue.DUPLICATE_FINISH);
      return;
    }
    span.finishedAtMs = time;
    span.state = success ? ETraceState.SUCCESS : ETraceState.FAILURE;
    if (span.startedAtMs === undefined) {
      this.issue(ETraceIssue.MISSING_START);
    } else if (time < span.startedAtMs) {
      this.issue(ETraceIssue.REVERSED_TIME);
    } else {
      span.durationMs = time - span.startedAtMs;
    }
  }

  private valid(event: AgentEvent): boolean {
    if (
      event.runId !== this.runId ||
      !Number.isFinite(event.elapsedMs) ||
      event.elapsedMs < 0 ||
      !Object.values(EAgentEventType).includes(event.type)
    ) {
      return false;
    }
    if ('step' in event && (!validCount(event.step) || event.step === 0)) {
      return false;
    }
    if (
      'toolCallId' in event &&
      (!validName(event.toolCallId, 128) || !validName(event.toolName, 256))
    ) {
      return false;
    }
    if (
      event.type === EAgentEventType.TOOL_CALL_FINISHED &&
      !event.success &&
      !Object.values(ToolErrorCode).includes(event.errorCode)
    ) {
      return false;
    }
    if (
      event.type === EAgentEventType.RUN_FINISHED &&
      ![
        ...Object.values(EAgentStatus),
        ...Object.values(EAgentRunFailure),
      ].includes(event.status)
    ) {
      return false;
    }
    if (
      event.type === EAgentEventType.RUN_FINISHED &&
      !validCount(event.steps)
    ) {
      return false;
    }
    if (
      'errorCode' in event &&
      event.type === EAgentEventType.RUN_FINISHED &&
      event.errorCode !== undefined &&
      ![
        ...Object.values(ModelErrorCode),
        ...Object.values(EContextErrorCode),
      ].includes(event.errorCode)
    ) {
      return false;
    }
    if (
      event.type === EAgentEventType.MODEL_FINISHED &&
      [event.usage.inputTokens, event.usage.outputTokens].some(
        (n) => n !== undefined && !validCount(n),
      )
    ) {
      return false;
    }
    return true;
  }

  private sanitize(event: AgentEvent, sequence: number): TraceRecord {
    const base = {
      schemaVersion: 1,
      sequence,
      runId: this.runId,
      type: event.type,
      elapsedMs: event.elapsedMs,
    } as const;
    switch (event.type) {
      case EAgentEventType.RUN_STARTED:
        return { ...base, type: event.type };
      case EAgentEventType.MODEL_STARTED:
      case EAgentEventType.TEXT_DELTA:
        return { ...base, type: event.type, step: event.step };
      case EAgentEventType.MODEL_FINISHED:
        return {
          ...base,
          type: event.type,
          step: event.step,
          usage: {
            ...(event.usage.inputTokens === undefined
              ? {}
              : { inputTokens: event.usage.inputTokens }),
            ...(event.usage.outputTokens === undefined
              ? {}
              : { outputTokens: event.usage.outputTokens }),
          },
        };
      case EAgentEventType.TOOL_CALL_READY:
      case EAgentEventType.TOOL_CALL_STARTED:
        return {
          ...base,
          type: event.type,
          step: event.step,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        };
      case EAgentEventType.TOOL_CALL_FINISHED:
        return {
          ...base,
          type: event.type,
          step: event.step,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(event.success
            ? { success: true }
            : { success: false, errorCode: event.errorCode }),
        };
      case EAgentEventType.RUN_FINISHED:
        return {
          ...base,
          type: event.type,
          steps: event.steps,
          status: event.status,
          ...(event.errorCode === undefined
            ? {}
            : { errorCode: event.errorCode }),
        };
    }
  }
}
