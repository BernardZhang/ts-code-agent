import type {
  AgentEvent,
  EAgentStatus,
  EAgentRunFailure,
} from '../agent/runner.js';
import type { ToolErrorCode } from '../tools/result.js';

export enum ETraceState {
  READY = 'ready',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILURE = 'failure',
  NOT_EXECUTED = 'not_executed',
  INCOMPLETE = 'incomplete',
}
export enum ETraceIssue {
  INVALID_EVENT = 'invalid_event',
  MISSING_START = 'missing_start',
  DUPLICATE_START = 'duplicate_start',
  DUPLICATE_FINISH = 'duplicate_finish',
  AFTER_TERMINAL = 'after_terminal',
  LIMIT = 'summary_limit',
  INCONSISTENT_CALL = 'inconsistent_call',
  REVERSED_TIME = 'reversed_time',
}

type WithoutText<T> = T extends { text: string } ? Omit<T, 'text'> : T;
export type TraceRecord = WithoutText<AgentEvent> & {
  schemaVersion: 1;
  sequence: number;
};
export interface TraceSpan {
  state: ETraceState;
  startedAtMs?: number;
  finishedAtMs?: number;
  durationMs?: number;
}
export interface TraceModel extends TraceSpan {
  step: number;
}
export interface TraceTool extends TraceSpan {
  step: number;
  toolCallId: string;
  toolName: string;
  readyAtMs?: number;
  errorCode?: ToolErrorCode;
}
export interface TraceSnapshot {
  runId: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  status?: EAgentStatus | EAgentRunFailure;
  models: TraceModel[];
  tools: TraceTool[];
  receivedCount: number;
  rejectedCount: number;
  issueCount: number;
  issues: Array<{ sequence: number; reason: ETraceIssue }>;
  summaryTruncated: boolean;
}
export interface TraceLimits {
  maxModels: number;
  maxTools: number;
  maxIssues: number;
}
