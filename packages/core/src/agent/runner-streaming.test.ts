import { describe, expect, it, vi } from 'vitest';
import type { AgentRunOptions } from './runner.js';
import { AgentRunner, EAgentEventType, type AgentEvent } from './runner.js';
import { EModelEventType, type ModelEvent } from '../model/events.js';
import { ModelErrorCode } from '../model/errors.js';
import { EMessageRole } from '../model/messages.js';
import type { ModelProvider, ModelResult } from '../model/provider.js';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';

const answer: ModelResult = { text: '你好', usage: { outputTokens: 2 } };
function setup(stream: ModelProvider['stream']) {
  const provider: ModelProvider = {
    capabilities: { structuredOutput: false },
    generate: async () => answer,
    stream,
  };
  const executor = new ToolExecutor(new ToolRegistry());
  const execute = vi.spyOn(executor, 'execute');
  const runner = new AgentRunner(provider, executor);
  const events: AgentEvent[] = [];
  const options: AgentRunOptions = {
    request: {
      model: 'stream-test',
      messages: [{ role: EMessageRole.USER, content: '问题' }],
    },
    maxSteps: 3,
    stream: true,
    onEvent: (event: AgentEvent) => {
      events.push(event);
    },
  };
  return { runner, events, options, execute };
}

describe('AgentRunner 流完成边界', () => {
  it('模型完成通知在迭代结束后发送，携带步数和统计', async () => {
    let iteratorFinished = false;
    const s = setup(async function* () {
      yield { type: EModelEventType.TEXT_DELTA, text: '你好' };
      yield { type: EModelEventType.DONE, result: answer };
      iteratorFinished = true;
    });
    await s.runner.run({
      ...s.options,
      onEvent(event) {
        if (event.type === EAgentEventType.MODEL_FINISHED) {
          expect(iteratorFinished).toBe(true);
        }
        s.events.push(event);
      },
    });
    expect(s.events).toEqual([
      { type: EAgentEventType.TEXT_DELTA, text: '你好' },
      { type: EAgentEventType.MODEL_FINISHED, step: 1, usage: answer.usage },
    ]);
  });

  it.each([true, false])(
    '等待最终 next 时取消，不发送完成通知（有 DONE：%s）',
    async (sendDone) => {
      const controller = new AbortController();
      const reason = new Error('在最后一次 next 期间取消');
      const s = setup(async function* (): AsyncGenerator<ModelEvent> {
        if (sendDone) {
          yield { type: EModelEventType.DONE, result: answer };
        }
        // 模拟底层在 next() 等待中收到取消，随后正常结束迭代。
        await Promise.resolve();
        controller.abort(reason);
      });
      await expect(
        s.runner.run({
          ...s.options,
          request: { ...s.options.request, signal: controller.signal },
        }),
      ).rejects.toBe(reason);
      expect(s.events).toEqual([]);
    },
  );

  it('DONE 后额外事件是协议错误，不通知完成或执行工具', async () => {
    const s = setup(async function* () {
      yield {
        type: EModelEventType.DONE,
        result: { ...answer, toolCalls: [{ name: 'lookup', arguments: {} }] },
      };
      yield { type: EModelEventType.TEXT_DELTA, text: '非法尾部' };
    });
    await expect(s.runner.run(s.options)).rejects.toHaveProperty(
      'code',
      ModelErrorCode.PROTOCOL,
    );
    expect(s.events).toEqual([]);
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('DONE 后迭代器抛错，不通知模型完成', async () => {
    const failure = new Error('读取尾部失败');
    const s = setup(async function* () {
      yield { type: EModelEventType.DONE, result: answer };
      throw failure;
    });
    await expect(s.runner.run(s.options)).rejects.toBe(failure);
    expect(s.events).toEqual([]);
  });

  it('两次模型请求各发送一次完成通知，第一次仍需执行工具', async () => {
    let calls = 0;
    const s = setup(async function* () {
      calls += 1;
      yield {
        type: EModelEventType.DONE,
        result:
          calls === 1
            ? { ...answer, toolCalls: [{ name: 'lookup', arguments: {} }] }
            : answer,
      };
    });
    const result = await s.runner.run(s.options);
    expect(result.steps).toBe(2);
    expect(s.events).toEqual([
      { type: EAgentEventType.MODEL_FINISHED, step: 1, usage: answer.usage },
      { type: EAgentEventType.MODEL_FINISHED, step: 2, usage: answer.usage },
    ]);
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it('非流式路径也通知模型完成', async () => {
    const s = setup(() => {
      throw new Error('不应走流式路径');
    });
    await s.runner.run({ ...s.options, stream: false });
    expect(s.events).toEqual([
      { type: EAgentEventType.MODEL_FINISHED, step: 1, usage: answer.usage },
    ]);
  });
});
