import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { EMessageRole } from '../model/messages.js';
import { expect, it } from 'vitest';
import { TraceCollector } from './collector.js';
import { ETraceState, ETraceIssue } from './types.js';
import {
  AgentRunner,
  EAgentStatus,
  EAgentEventType,
  EAgentRunFailure,
  type AgentEvent,
} from '../agent/runner.js';

const RUN = 'run-test';
const base = { runId: RUN, elapsedMs: 0 };

it('显式脱敏并返回独立快照，序号按接收顺序增长', () => {
  const collector = new TraceCollector(RUN);
  const input: AgentEvent = {
    ...base,
    type: EAgentEventType.TEXT_DELTA,
    step: 1,
    text: 'SECRET-TEST',
  };
  const record = collector.record(input);
  expect(record).toEqual({
    schemaVersion: 1,
    sequence: 1,
    runId: RUN,
    elapsedMs: 0,
    type: EAgentEventType.TEXT_DELTA,
    step: 1,
  });
  input.text = 'modified';
  if (record) {
    record.runId = 'changed';
  }
  const snapshot = collector.getSnapshot();
  snapshot.runId = 'changed';
  expect(collector.getSnapshot().runId).toBe(RUN);
  expect(JSON.stringify(collector.getSnapshot())).not.toContain('SECRET-TEST');
  expect(
    collector.record({ ...base, type: EAgentEventType.RUN_STARTED })?.sequence,
  ).toBe(2);
});

it('并行逆序结束按ID配对，耗时分别为100和20', () => {
  const collector = new TraceCollector(RUN);
  collector.record({ ...base, type: EAgentEventType.RUN_STARTED });
  for (const id of ['A', 'B']) {
    collector.record({
      ...base,
      type: EAgentEventType.TOOL_CALL_READY,
      toolCallId: id,
      toolName: 'read_file',
      step: 1,
    });
  }
  for (const [id, time] of [
    ['A', 10],
    ['B', 12],
  ] as const) {
    collector.record({
      ...base,
      elapsedMs: time,
      type: EAgentEventType.TOOL_CALL_STARTED,
      toolCallId: id,
      toolName: 'read_file',
      step: 1,
    });
  }
  for (const [id, time] of [
    ['B', 32],
    ['A', 110],
  ] as const) {
    collector.record({
      ...base,
      elapsedMs: time,
      type: EAgentEventType.TOOL_CALL_FINISHED,
      toolCallId: id,
      toolName: 'read_file',
      step: 1,
      success: true,
    });
  }
  expect(
    collector.getSnapshot().tools.map(({ durationMs }) => durationMs),
  ).toEqual([100, 20]);
  const snapshot = collector.getSnapshot();
  const first = snapshot.tools[0];
  if (first) {
    first.toolName = 'changed';
  }
  expect(collector.getSnapshot().tools[0]?.toolName).toBe('read_file');
});

it('run取消时区分未执行和已启动缺少结果', () => {
  const collector = new TraceCollector(RUN);
  for (const id of ['A', 'B']) {
    collector.record({
      ...base,
      type: EAgentEventType.TOOL_CALL_READY,
      toolCallId: id,
      toolName: 'read_file',
      step: 1,
    });
  }
  collector.record({
    ...base,
    elapsedMs: 1,
    type: EAgentEventType.TOOL_CALL_STARTED,
    toolCallId: 'B',
    toolName: 'read_file',
    step: 1,
  });
  collector.record({
    ...base,
    elapsedMs: 2,
    type: EAgentEventType.RUN_FINISHED,
    status: EAgentRunFailure.CANCELLED,
    steps: 1,
  });
  expect(collector.getSnapshot().tools.map(({ state }) => state)).toEqual([
    ETraceState.NOT_EXECUTED,
    ETraceState.INCOMPLETE,
  ]);
  expect(
    collector
      .getSnapshot()
      .tools.every(({ durationMs }) => durationMs === undefined),
  ).toBe(true);
});

it('缺失开始仍保留结束，重复及终态后事件留痕且不改首次结果', () => {
  const collector = new TraceCollector(RUN);
  const finish = {
    ...base,
    elapsedMs: 10,
    type: EAgentEventType.TOOL_CALL_FINISHED,
    toolCallId: 'A',
    toolName: 'read_file',
    step: 1,
    success: true,
  } as const;
  collector.record(finish);
  collector.record(finish);
  collector.record({
    ...base,
    elapsedMs: 11,
    type: EAgentEventType.RUN_FINISHED,
    status: EAgentRunFailure.FAILED,
    steps: 1,
  });
  expect(collector.record({ ...finish, elapsedMs: 12 })?.sequence).toBe(4);
  const snapshot = collector.getSnapshot();
  expect(snapshot.tools[0]).toMatchObject({
    state: ETraceState.SUCCESS,
    finishedAtMs: 10,
  });
  expect(snapshot.tools[0]?.durationMs).toBeUndefined();
  expect(snapshot.issues.map(({ reason }) => reason)).toContain(
    ETraceIssue.MISSING_START,
  );
  expect(snapshot.issues.map(({ reason }) => reason)).toContain(
    ETraceIssue.DUPLICATE_FINISH,
  );
  expect(snapshot.issues.map(({ reason }) => reason)).toContain(
    ETraceIssue.AFTER_TERMINAL,
  );
});

it('拒绝非法元数据，限制摘要与异常样例并报告截断', () => {
  const collector = new TraceCollector(RUN, {
    maxModels: 1,
    maxTools: 1,
    maxIssues: 1,
  });
  expect(
    collector.record({
      ...base,
      runId: 'wrong',
      type: EAgentEventType.RUN_STARTED,
    }),
  ).toBeUndefined();
  expect(
    collector.record({
      ...base,
      elapsedMs: NaN,
      type: EAgentEventType.RUN_STARTED,
    }),
  ).toBeUndefined();
  expect(
    collector.record({
      ...base,
      type: EAgentEventType.TOOL_CALL_READY,
      step: 1,
      toolCallId: 'long',
      toolName: 'x'.repeat(257),
    }),
  ).toBeUndefined();
  for (const id of ['A', 'B']) {
    collector.record({
      ...base,
      type: EAgentEventType.TOOL_CALL_READY,
      step: 1,
      toolCallId: id,
      toolName: 'lookup',
    });
  }
  for (const step of [1, 2]) {
    collector.record({ ...base, type: EAgentEventType.MODEL_STARTED, step });
  }
  const snapshot = collector.getSnapshot();
  expect(snapshot.rejectedCount).toBe(3);
  expect(snapshot.tools).toHaveLength(1);
  expect(snapshot.models).toHaveLength(1);
  expect(snapshot.issues).toHaveLength(1);
  expect(snapshot.issueCount).toBeGreaterThan(1);
  expect(snapshot.summaryTruncated).toBe(true);
});

it('模型已完成后run失败保留模型完成，缺少完成事件的步骤标记不完整', () => {
  const collector = new TraceCollector(RUN);
  collector.record({ ...base, type: EAgentEventType.MODEL_STARTED, step: 1 });
  const usage = { inputTokens: 10, outputTokens: 2 };
  Object.assign(usage, { secret: 'USAGE-SECRET' });
  const record = collector.record({
    ...base,
    elapsedMs: 20,
    type: EAgentEventType.MODEL_FINISHED,
    step: 1,
    usage,
    finishReason: 'PRIVATE-FINISH',
  });
  usage.inputTokens = 99;
  expect(JSON.stringify(record)).not.toContain('USAGE-SECRET');
  expect(JSON.stringify(record)).not.toContain('PRIVATE-FINISH');
  expect(record).toMatchObject({ usage: { inputTokens: 10, outputTokens: 2 } });
  collector.record({
    ...base,
    elapsedMs: 30,
    type: EAgentEventType.MODEL_STARTED,
    step: 2,
  });
  collector.record({
    ...base,
    elapsedMs: 50,
    type: EAgentEventType.RUN_FINISHED,
    status: EAgentRunFailure.FAILED,
    steps: 2,
  });
  expect(collector.getSnapshot().models).toEqual([
    {
      step: 1,
      state: ETraceState.SUCCESS,
      startedAtMs: 0,
      finishedAtMs: 20,
      durationMs: 20,
    },
    { step: 2, state: ETraceState.INCOMPLETE, startedAtMs: 30 },
  ]);
});

it('乱序时间不生成负耗时，跨step复用调用ID不覆盖原调用', () => {
  const collector = new TraceCollector(RUN);
  const fields = { toolCallId: 'A', toolName: 'lookup', step: 1 };
  collector.record({
    ...base,
    ...fields,
    elapsedMs: 10,
    type: EAgentEventType.TOOL_CALL_STARTED,
  });
  collector.record({
    ...base,
    ...fields,
    elapsedMs: 5,
    type: EAgentEventType.TOOL_CALL_FINISHED,
    success: true,
  });
  collector.record({
    ...base,
    ...fields,
    step: 2,
    type: EAgentEventType.TOOL_CALL_READY,
  });
  const snapshot = collector.getSnapshot();
  expect(snapshot.tools[0]?.durationMs).toBeUndefined();
  expect(snapshot.tools[0]?.step).toBe(1);
  expect(snapshot.issues.map(({ reason }) => reason)).toEqual([
    ETraceIssue.REVERSED_TIME,
    ETraceIssue.INCONSISTENT_CALL,
  ]);
});

it('消费真实Runner事件保持run关联，正常完成后可读取步骤耗时', async () => {
  let collector: TraceCollector | undefined;
  const runner = new AgentRunner(
    {
      capabilities: { structuredOutput: false },
      generate: async () => ({ text: 'PRIVATE-ANSWER', usage: {} }),
      stream: () => {
        throw new Error('本例使用非流式');
      },
    },
    new ToolExecutor(new ToolRegistry()),
  );
  await runner.run({
    request: {
      model: 'fake',
      messages: [{ role: EMessageRole.USER, content: 'PRIVATE-INPUT' }],
    },
    maxSteps: 1,
    onEvent(event) {
      collector ??= new TraceCollector(event.runId);
      expect(collector.record(event)).toBeDefined();
    },
  });
  const snapshot = collector?.getSnapshot();
  expect(snapshot?.status).toBe(EAgentStatus.COMPLETE);
  expect(snapshot?.models[0]?.state).toBe(ETraceState.SUCCESS);
  expect(snapshot?.models[0]?.durationMs).toBeGreaterThanOrEqual(0);
  expect(snapshot?.receivedCount).toBe(4);
  expect(snapshot?.issueCount).toBe(0);
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
});

it('模型开始后，取消run仍保留模型开始，缺少完成事件的步骤标记不完整', async () => {
  let collector: TraceCollector | undefined;
  const runner = new AgentRunner(
    {
      capabilities: { structuredOutput: false },
      generate: async () => ({ text: 'PRIVATE-ANSWER', usage: {} }),
      stream: () => {
        throw new Error('本例使用非流式');
      },
    },
    new ToolExecutor(new ToolRegistry()),
  );
  const controller = new AbortController();
  const runPromise = runner.run({
    request: {
      model: 'fake',
      messages: [{ role: EMessageRole.USER, content: 'PRIVATE-INPUT' }],
      signal: controller.signal,
    },
    maxSteps: 1,
    onEvent(event) {
      collector ??= new TraceCollector(event.runId);
      expect(collector.record(event)).toBeDefined();
      if (event.type === EAgentEventType.MODEL_STARTED) {
        controller.abort();
      }
    },
  });
  await expect(runPromise).rejects.toThrowError(/aborted/i);
  const snapshot = collector?.getSnapshot();
  expect(snapshot?.status).toBe(EAgentRunFailure.CANCELLED);
  expect(snapshot?.models[0]?.state).toBe(ETraceState.INCOMPLETE);
  expect(snapshot?.models[0]?.startedAtMs).toBeGreaterThanOrEqual(0);
  expect(snapshot?.models[0]?.finishedAtMs).toBeUndefined();
  expect(snapshot?.models[0]?.durationMs).toBeUndefined();
  expect(snapshot?.receivedCount).toBe(3);
  expect(snapshot?.issueCount).toBe(0);
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
});
