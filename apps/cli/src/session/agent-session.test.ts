import { describe, expect, it, vi } from 'vitest';
import {
  AgentRunner,
  ContextManager,
  EAgentStatus,
  EContextErrorCode,
  EMessageRole,
  ToolExecutor,
  ToolRegistry,
  ToolErrorCode,
  type ModelProvider,
  type ModelResult,
} from '@ts-code-agent/core';
import {
  AgentSession,
  ESessionErrorCode,
  ESessionState,
} from './agent-session.js';

const MODEL = 'session-test';
const SYSTEM_PROMPT = '依据工具证据回答。';
const LOOKUP_TOOL = 'lookup';
const answer = (text: string): ModelResult => ({ text, usage: {} });
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Promise 未初始化');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}
function setup(maxSteps = 3, contextManager?: ContextManager) {
  const generate = vi.fn<ModelProvider['generate']>();
  const provider: ModelProvider = {
    capabilities: { structuredOutput: false },
    // Runner 会继续追加自己的请求数组；记录调用时快照，避免断言读到后续结果。
    generate(request) {
      return generate({
        ...request,
        messages: structuredClone(request.messages),
      });
    },
    stream() {
      throw new Error('本任务不使用流式生成');
    },
  };
  const runner = new AgentRunner(
    provider,
    new ToolExecutor(new ToolRegistry()),
  );
  const session = new AgentSession(runner, {
    request: { model: MODEL, contextLength: 8192 },
    systemPrompt: SYSTEM_PROMPT,
    maxSteps,
    ...(contextManager === undefined ? {} : { contextManager }),
  });
  return { session, generate };
}

describe('AgentSession', () => {
  it('连续两轮携带完整历史，每轮从头计步，不重复保存消息', async () => {
    const { session, generate } = setup();
    generate
      .mockResolvedValueOnce(answer('第一轮回答'))
      .mockResolvedValueOnce(answer('第二轮回答'));
    expect(session.state).toBe(ESessionState.IDLE);
    const first = await session.submit('第一轮');
    const second = await session.submit('第二轮');
    expect(first.steps).toBe(1);
    expect(second.steps).toBe(1);
    expect(generate.mock.calls[1]?.[0].messages).toEqual([
      { role: EMessageRole.SYSTEM, content: SYSTEM_PROMPT },
      { role: EMessageRole.USER, content: '第一轮' },
      { role: EMessageRole.ASSISTANT, content: '第一轮回答' },
      { role: EMessageRole.USER, content: '第二轮' },
    ]);
    expect(session.history).toHaveLength(5);
    expect(session.state).toBe(ESessionState.IDLE);
  });

  it('保存 assistant/tool 关系，普通工具失败仍是完整历史', async () => {
    const { session, generate } = setup();
    generate
      .mockResolvedValueOnce({
        ...answer(''),
        toolCalls: [{ name: LOOKUP_TOOL, arguments: {} }],
      })
      .mockResolvedValueOnce(answer('工具不可用'))
      .mockResolvedValueOnce(answer('后续回答'));
    await session.submit('调用工具');
    await session.submit('继续');
    const messages = generate.mock.calls[2]?.[0].messages;
    expect(messages?.map((message) => message.role)).toEqual([
      EMessageRole.SYSTEM,
      EMessageRole.USER,
      EMessageRole.ASSISTANT,
      EMessageRole.TOOL,
      EMessageRole.ASSISTANT,
      EMessageRole.USER,
    ]);
    expect(
      messages?.find((message) => message.role === EMessageRole.TOOL)?.content,
    ).toContain(ToolErrorCode.UNKNOWN_TOOL);
  });

  it('步数耗尽也保存完整工具结果，但不改成 COMPLETE', async () => {
    const { session, generate } = setup(1);
    generate
      .mockResolvedValueOnce({
        ...answer(''),
        toolCalls: [{ name: LOOKUP_TOOL, arguments: {} }],
      })
      .mockResolvedValueOnce(answer('继续后的回答'));
    const result = await session.submit('调用工具');
    expect(result.status).toBe(EAgentStatus.MAX_STEPS);
    expect(session.history.at(-1)?.role).toBe(EMessageRole.TOOL);
    await session.submit('继续');
    expect(generate.mock.calls[1]?.[0].messages).toHaveLength(5);
  });

  it('Provider 在工具轮次后失败时回退整轮，保留更早成功历史', async () => {
    const { session, generate } = setup();
    const failure = new Error('provider failed');
    generate
      .mockResolvedValueOnce(answer('已有回答'))
      .mockResolvedValueOnce({
        ...answer(''),
        toolCalls: [{ name: LOOKUP_TOOL, arguments: {} }],
      })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(answer('恢复回答'));
    await session.submit('已有问题');
    const committed = session.history;
    await expect(session.submit('失败问题')).rejects.toBe(failure);
    expect(session.state).toBe(ESessionState.IDLE);
    expect(session.history).toEqual(committed);
    await session.submit('新问题');
    expect(generate.mock.calls[3]?.[0].messages).toEqual([
      ...committed,
      { role: EMessageRole.USER, content: '新问题' },
    ]);
  });

  it('取消不提前恢复空闲；本轮收尾后可用全新信号继续', async () => {
    const { session, generate } = setup();
    const started = deferred<void>();
    const release = deferred<void>();
    generate
      .mockImplementationOnce(async () => {
        started.resolve();
        await release.promise;
        return answer('忽略信号后仍返回的旧回答');
      })
      .mockResolvedValueOnce(answer('新回答'));
    const pending = session.submit('将被取消');
    const rejected = expect(pending).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
    await started.promise;
    const firstSignal = generate.mock.calls[0]?.[0].signal;
    session.cancelCurrent();
    expect(firstSignal?.aborted).toBe(true);
    expect(session.state).toBe(ESessionState.RUNNING);
    await expect(session.submit('太早提交')).rejects.toHaveProperty(
      'code',
      ESessionErrorCode.BUSY,
    );
    expect(session.history).toEqual([
      { role: EMessageRole.SYSTEM, content: SYSTEM_PROMPT },
    ]);
    release.resolve();
    await rejected;
    expect(session.state).toBe(ESessionState.IDLE);
    await session.submit('新问题');
    const next = generate.mock.calls[1]?.[0];
    expect(next?.signal).not.toBe(firstSignal);
    expect(next?.signal?.aborted).toBe(false);
    expect(next?.messages).toEqual([
      { role: EMessageRole.SYSTEM, content: SYSTEM_PROMPT },
      { role: EMessageRole.USER, content: '新问题' },
    ]);
  });

  it('运行中拒绝重置和并发提交，取消空闲任务没有副作用', async () => {
    const { session, generate } = setup();
    const gate = deferred<ModelResult>();
    generate.mockReturnValueOnce(gate.promise);
    session.cancelCurrent();
    const pending = session.submit('进行中');
    await expect(session.submit('并发')).rejects.toHaveProperty(
      'code',
      ESessionErrorCode.BUSY,
    );
    expect(() => session.reset()).toThrow(
      expect.objectContaining({ code: ESessionErrorCode.BUSY }),
    );
    expect(generate).toHaveBeenCalledTimes(1);
    gate.resolve(answer('完成'));
    await pending;
  });

  it('reset 只清除对话，保留系统规则与请求配置', async () => {
    const { session, generate } = setup();
    generate.mockResolvedValue(answer('回答'));
    await session.submit('旧问题');
    session.reset();
    expect(session.history).toEqual([
      { role: EMessageRole.SYSTEM, content: SYSTEM_PROMPT },
    ]);
    await session.submit('新问题');
    expect(generate.mock.calls[1]?.[0]).toMatchObject({
      model: MODEL,
      contextLength: 8192,
    });
    expect(generate.mock.calls[1]?.[0].messages).toHaveLength(2);
  });

  it('空输入不启动任务，合法输入保留原始空白', async () => {
    const { session, generate } = setup();
    for (const input of ['', ' ', '\n\t']) {
      await expect(session.submit(input)).rejects.toHaveProperty(
        'code',
        ESessionErrorCode.EMPTY_INPUT,
      );
    }
    expect(generate).not.toHaveBeenCalled();
    generate.mockResolvedValue(answer('回答'));
    await session.submit('  保留缩进\n');
    expect(generate.mock.calls[0]?.[0].messages.at(-1)?.content).toBe(
      '  保留缩进\n',
    );
  });

  it('外部修改 getter 或返回结果不能污染保存的历史', async () => {
    const { session, generate } = setup();
    generate.mockResolvedValue(answer('回答'));
    const result = await session.submit('问题');
    const first = result.messages[0];
    if (first) {
      first.content = '篡改返回值';
    }
    const snapshot = session.history;
    const system = snapshot[0];
    if (system) {
      system.content = '篡改快照';
    }
    snapshot.length = 0;
    await session.submit('追问');
    expect(generate.mock.calls[1]?.[0].messages[0]?.content).toBe(
      SYSTEM_PROMPT,
    );
    expect(session.history).toHaveLength(5);
  });

  it('预算失败不请求 Provider，也不提交用户输入', async () => {
    const contextManager = new ContextManager(
      { contextWindow: 20, reservedOutputTokens: 1, toolDefinitionTokens: 0 },
      () => 100,
    );
    const { session, generate } = setup(3, contextManager);
    await expect(session.submit('预算超限')).rejects.toHaveProperty(
      'code',
      EContextErrorCode.BUDGET_EXCEEDED,
    );
    expect(generate).not.toHaveBeenCalled();
    expect(session.history).toHaveLength(1);
    expect(session.state).toBe(ESessionState.IDLE);
  });

  it('关闭是终态，关闭运行中的任务会取消且不提交历史', async () => {
    const { session, generate } = setup();
    const gate = deferred<ModelResult>();
    generate.mockReturnValueOnce(gate.promise);
    const pending = session.submit('进行中');
    const rejected = expect(pending).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
    session.close();
    session.close();
    gate.resolve(answer('旧回答'));
    await rejected;
    expect(session.state).toBe(ESessionState.CLOSED);
    await expect(session.submit('新任务')).rejects.toHaveProperty(
      'code',
      ESessionErrorCode.CLOSED,
    );
    expect(() => session.reset()).toThrow(
      expect.objectContaining({ code: ESessionErrorCode.CLOSED }),
    );
    expect(session.history).toHaveLength(1);
  });

  it('提前拒绝非法步数配置', () => {
    for (const maxSteps of [
      0,
      -1,
      1.5,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => setup(maxSteps)).toThrow(RangeError);
    }
  });
});
