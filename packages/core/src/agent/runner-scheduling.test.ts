import { expect, it, vi } from 'vitest';
import { AgentRunner, EAgentStatus, EToolExecution } from './runner.js';
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
  execute: (input: number, signal: AbortSignal) => Promise<number>,
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
  return {
    generate,
    runner: new AgentRunner(provider, new ToolExecutor(registry)),
  };
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
    if (input === 1) await first;
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
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  const { generate, runner } = setup(async (_input, signal) => {
    signals.push(signal);
    if (signals.length === 2) bothStarted();
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
    maxSteps: 2,
    toolExecution: EToolExecution.PARALLEL,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
  });
  await started;
  controller.abort();
  await rejected;
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(generate).toHaveBeenCalledTimes(1);
});
