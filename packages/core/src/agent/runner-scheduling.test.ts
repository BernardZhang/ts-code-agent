import { expect, it, vi } from 'vitest';
import {
  AgentRunner,
  EAgentEventType,
  EAgentRunFailure,
  EAgentStatus,
  EToolExecution,
  type AgentEvent,
} from './runner.js';
import { EMessageRole } from '../model/messages.js';
import type {
  ModelProvider,
  ModelRequest,
  ModelResult,
} from '../model/provider.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolErrorCode } from '../tools/result.js';

const call = (value: number): ModelResult => ({
  text: '',
  usage: {},
  toolCalls: [{ name: 'echo', arguments: value }],
});
const final: ModelResult = { text: '完成', usage: {} };
const request: ModelRequest = {
  model: 'fake',
  messages: [{ role: EMessageRole.USER, content: '测试' }],
};
function setup(
  execute: (input: number, signal: AbortSignal) => Promise<unknown>,
  timeoutMs?: number,
) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: '返回数字',
    parameters: { type: 'number' },
    inputSchema: {
      safeParse(value: unknown) {
        return typeof value === 'number'
          ? { success: true, data: value }
          : { success: false, error: { message: '需要数字' } };
      },
    },
    execute: (input, context) => execute(input, context.signal),
  });
  const generate = vi.fn<ModelProvider['generate']>();
  const provider: ModelProvider = {
    capabilities: { structuredOutput: false },
    generate,
    stream() {
      throw new Error('不使用流式');
    },
  };
  const executor = new ToolExecutor(registry, timeoutMs);
  return { generate, executor, runner: new AgentRunner(provider, executor) };
}

it('连续三轮工具调用，第四次模型请求包含全部结果后完成', async () => {
  const execute = vi.fn(async (input: number) => input);
  const { generate, runner } = setup(execute);
  generate
    .mockResolvedValueOnce(call(1))
    .mockResolvedValueOnce(call(2))
    .mockResolvedValueOnce(call(3))
    .mockImplementationOnce(async (input) => {
      expect(
        input.messages
          .filter((m) => m.role === EMessageRole.TOOL)
          .map((m) => m.content),
      ).toEqual(
        [1, 2, 3].map((output) => JSON.stringify({ success: true, output })),
      );
      return final;
    });
  const result = await runner.run({ request, maxSteps: 4 });
  expect(result.status).toBe(EAgentStatus.COMPLETE);
  expect(result.steps).toBe(4);
  expect(generate).toHaveBeenCalledTimes(4);
  expect(execute.mock.calls.map(([input]) => input)).toEqual([1, 2, 3]);
});

it('并行启动同轮工具，逆序完成仍按调用顺序回传，普通失败不丢失其他结果', async () => {
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const starts: number[] = [];
  const { generate, runner } = setup(async (input) => {
    starts.push(input);
    if (input === 1) {
      await first;
    }
    if (input === 2) {
      releaseFirst();
      throw new Error('第二个失败');
    }
    return input;
  });
  generate
    .mockResolvedValueOnce({
      text: '',
      usage: {},
      toolCalls: [
        { name: 'echo', arguments: 1 },
        { name: 'echo', arguments: 2 },
      ],
    })
    .mockImplementationOnce(async (input) => {
      const results = input.messages.filter(
        (m) => m.role === EMessageRole.TOOL,
      );
      expect(results).toHaveLength(2);
      expect(results.map((m) => JSON.parse(m.content))).toEqual([
        { success: true, output: 1 },
        {
          success: false,
          error: {
            code: ToolErrorCode.EXECUTION_FAILED,
            message: '第二个失败',
          },
        },
      ]);
      return final;
    });
  const result = await runner.run({
    request,
    maxSteps: 2,
    toolExecution: EToolExecution.PARALLEL,
  });
  expect(starts).toEqual([1, 2]);
  expect(result.status).toBe(EAgentStatus.COMPLETE);
});

it('并行取消通知所有已启动工具，不再请求模型', async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  const events: AgentEvent[] = [];
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const { generate, runner } = setup(async (_input, signal) => {
    signals.push(signal);
    if (signals.length === 2) {
      bothStarted();
    }
    return new Promise<number>(() => {});
  });
  generate.mockResolvedValueOnce({
    text: '',
    usage: {},
    toolCalls: [
      { name: 'echo', arguments: 1 },
      { name: 'echo', arguments: 2 },
    ],
  });
  const pending = runner.run({
    request: { ...request, signal: controller.signal },
    onEvent: (event) => events.push(event),
    maxSteps: 2,
    toolExecution: EToolExecution.PARALLEL,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
  });
  await started;
  controller.abort();
  await rejected;
  expect(events.slice(-3)).toMatchObject([
    {
      type: EAgentEventType.TOOL_CALL_FINISHED,
      success: false,
      errorCode: ToolErrorCode.CANCELLED,
    },
    {
      type: EAgentEventType.TOOL_CALL_FINISHED,
      success: false,
      errorCode: ToolErrorCode.CANCELLED,
    },
    {
      type: EAgentEventType.RUN_FINISHED,
      status: EAgentRunFailure.CANCELLED,
      steps: 1,
    },
  ]);
  expect(
    events.filter(({ type }) => type === EAgentEventType.RUN_FINISHED),
  ).toHaveLength(1);
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(generate).toHaveBeenCalledTimes(1);
});

it('最后一步并行工具先成功后超时，按调用顺序保留结果且不再请求模型', async () => {
  vi.useFakeTimers();
  try {
    const timeoutMs = 100;
    const timeline: Array<EAgentEventType | number> = [];
    const events: AgentEvent[] = [];
    const { generate, executor, runner } = setup(async (input, signal) => {
      timeline.push(input);
      if (input === 1) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      }
      return input;
    }, timeoutMs);
    const execute = vi.spyOn(executor, 'execute');
    const toolCalls = [
      { name: 'echo', arguments: 1 },
      { name: 'echo', arguments: 2 },
    ];
    generate.mockResolvedValueOnce({ ...final, toolCalls });
    const pending = runner.run({
      request,
      maxSteps: 1,
      toolExecution: EToolExecution.PARALLEL,
      onEvent: (event) => {
        events.push(event);
        if (event.type === EAgentEventType.MODEL_FINISHED) {
          timeline.push(event.type);
        }
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(timeline).toEqual([EAgentEventType.MODEL_FINISHED, 1, 2]);
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(execute.mock.results[1]?.value).resolves.toEqual({
      success: true,
      output: 2,
    });

    // B 已完成，再推进时钟触发 A 的真实执行器超时。
    await vi.advanceTimersByTimeAsync(timeoutMs);
    const result = await pending;
    expect(events.map(({ type }) => type)).toEqual([
      EAgentEventType.RUN_STARTED,
      EAgentEventType.MODEL_STARTED,
      EAgentEventType.MODEL_FINISHED,
      EAgentEventType.TOOL_CALL_READY,
      EAgentEventType.TOOL_CALL_READY,
      EAgentEventType.TOOL_CALL_STARTED,
      EAgentEventType.TOOL_CALL_STARTED,
      EAgentEventType.TOOL_CALL_FINISHED,
      EAgentEventType.TOOL_CALL_FINISHED,
      EAgentEventType.RUN_FINISHED,
    ]);
    expect(events.at(-1)).toMatchObject({
      status: EAgentStatus.MAX_STEPS,
      steps: 1,
    });
    const ready = events.filter(
      (event) => event.type === EAgentEventType.TOOL_CALL_READY,
    );
    const started = events.filter(
      (event) => event.type === EAgentEventType.TOOL_CALL_STARTED,
    );
    const finished = events.filter(
      (event) => event.type === EAgentEventType.TOOL_CALL_FINISHED,
    );
    expect(ready).toHaveLength(2);
    expect(ready[0]?.toolCallId).not.toBe(ready[1]?.toolCallId);
    expect(started.map(({ toolCallId }) => toolCallId)).toEqual(
      ready.map(({ toolCallId }) => toolCallId),
    );
    expect(finished).toMatchObject([
      { toolCallId: ready[1]?.toolCallId, success: true },
      {
        toolCallId: ready[0]?.toolCallId,
        success: false,
        errorCode: ToolErrorCode.TIMEOUT,
      },
    ]);
    expect(finished[0]?.elapsedMs).toBeLessThan(finished[1]?.elapsedMs ?? 0);
    expect(events[0]?.runId).toBeTruthy();
    expect(new Set(events.map(({ runId }) => runId)).size).toBe(1);
    expect(result.status).toBe(EAgentStatus.MAX_STEPS);
    expect(result.steps).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.messages.slice(1, 2)).toEqual([
      { role: EMessageRole.ASSISTANT, content: final.text, toolCalls },
    ]);
    const toolMessages = result.messages.slice(2);
    expect(toolMessages.map(({ role }) => role)).toEqual([
      EMessageRole.TOOL,
      EMessageRole.TOOL,
    ]);
    expect(toolMessages.map(({ content }) => JSON.parse(content))).toEqual([
      {
        success: false,
        error: expect.objectContaining({ code: ToolErrorCode.TIMEOUT }),
      },
      { success: true, output: 2 },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it('将工具结果里的 BigInt 无损转为十进制字符串后回传模型', async () => {
  const { generate, runner } = setup(async () => ({
    counts: [9007199254740993n],
  }));
  const events: AgentEvent[] = [];
  generate
    .mockResolvedValueOnce(call(1))
    .mockImplementationOnce(async (input) => {
      expect(input.messages.at(-1)).toEqual({
        role: EMessageRole.TOOL,
        name: 'echo',
        content: '{"success":true,"output":{"counts":["9007199254740993"]}}',
      });
      return final;
    });
  const result = await runner.run({
    request,
    maxSteps: 2,
    onEvent: (event) => events.push(event),
  });
  expect(result.status).toBe(EAgentStatus.COMPLETE);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(
    events.filter(({ type }) => type === EAgentEventType.TOOL_CALL_FINISHED),
  ).toMatchObject([{ success: true }]);
});
