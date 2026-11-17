import {
  READ_FILE_TOOL_NAME,
  SEARCH_CODE_TOOL_NAME,
} from '@ts-code-agent/code-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRunner,
  ContextManager,
  EAgentStatus,
  EAgentEventType,
  ETaskStepStatus,
  EModelEventType,
  EContextErrorCode,
  EMessageRole,
  ToolExecutor,
  ToolRegistry,
  ToolErrorCode,
  type AgentEvent,
  type ModelEvent,
  type ModelProvider,
  type ModelResult,
} from '@ts-code-agent/core';
import {
  AgentSession,
  ESessionErrorCode,
  ESessionState,
} from './agent-session.js';

import {
  EPlanUpdateOperation,
  UPDATE_PLAN_TOOL_NAME,
} from './update-plan-tool.js';

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
function setup(
  maxSteps = 3,
  contextManager?: ContextManager,
  supportStream?: boolean,
  registry = new ToolRegistry(),
  generatePlan?: ConstructorParameters<typeof AgentSession>[1]['generatePlan'],
) {
  const generate = vi.fn<ModelProvider['generate']>();
  const stream = vi.fn<ModelProvider['stream']>();
  const provider: ModelProvider = {
    capabilities: { structuredOutput: false },
    // Runner 会继续追加自己的请求数组；记录调用时快照，避免断言读到后续结果。
    generate(request) {
      return generate({
        ...request,
        messages: structuredClone(request.messages),
      });
    },
    stream(request) {
      return stream({
        ...request,
        messages: structuredClone(request.messages),
      });
    },
  };
  const runner = new AgentRunner(provider, new ToolExecutor(registry));
  const session = new AgentSession(runner, {
    request: { model: MODEL, contextLength: 8192 },
    systemPrompt: SYSTEM_PROMPT,
    maxSteps,
    ...(generatePlan === undefined ? {} : { generatePlan }),
    ...(supportStream === undefined ? {} : { stream: supportStream }),
    ...(contextManager === undefined ? {} : { contextManager }),
  });
  return { session, generate, stream };
}

describe('AgentSession', () => {
  it('在下一次请求和下一轮公布成功的仓库工具引用，更换计划后清空', async () => {
    const registry = new ToolRegistry();
    for (const name of [READ_FILE_TOOL_NAME, LOOKUP_TOOL]) {
      registry.register({
        name,
        description: '测试查询工具',
        parameters: {},
        inputSchema: { safeParse: () => ({ success: true, data: {} }) },
        execute: async () => '文件内容',
      });
    }
    const { session, generate } = setup(
      3,
      undefined,
      undefined,
      registry,
      async (goal) => ({
        goal,
        steps: [
          { id: 0, description: '定位入口', status: ETaskStepStatus.PENDING },
        ],
      }),
    );
    generate
      .mockResolvedValueOnce({
        ...answer(''),
        toolCalls: [
          READ_FILE_TOOL_NAME,
          SEARCH_CODE_TOOL_NAME,
          LOOKUP_TOOL,
        ].map((name) => ({
          name,
          arguments: {},
        })),
      })
      .mockResolvedValue(answer('回答'));
    const events: AgentEvent[] = [];
    await session.startPlan('分析 CLI', (event) => events.push(event));
    const finished = events.find(
      (event) =>
        event.type === EAgentEventType.TOOL_CALL_FINISHED &&
        event.toolName === READ_FILE_TOOL_NAME,
    );
    if (finished?.type !== EAgentEventType.TOOL_CALL_FINISHED) {
      throw new Error('缺少工具完成事件');
    }
    const reference = JSON.stringify({
      runId: finished.runId,
      toolCallId: finished.toolCallId,
      toolName: READ_FILE_TOOL_NAME,
    });
    const context = (index: number) =>
      generate.mock.calls[index]?.[0].messages[0]?.content;
    expect(context(0)).not.toContain(reference);
    expect(context(1)).toContain(reference);
    expect(context(1)).not.toContain('"toolCallId":"1:2"');
    expect(context(1)).not.toContain('"toolCallId":"1:3"');
    expect(generate.mock.calls[1]?.[0].messages).toContainEqual({
      role: EMessageRole.TOOL,
      name: READ_FILE_TOOL_NAME,
      content: JSON.stringify({ success: true, output: '文件内容' }),
    });
    expect(session.plan?.steps[0]?.status).toBe(ETaskStepStatus.PENDING);
    await session.submit('继续');
    expect(context(2)).toContain(reference);
    await session.startPlan('分析测试');
    expect(context(3)).not.toContain(reference);
  });

  it.each([false, true])(
    '模型通过 update_plan 提交进度，下一次请求看到已完成状态（stream=%s）',
    async (useStream) => {
      const registry = new ToolRegistry();
      registry.register({
        name: READ_FILE_TOOL_NAME,
        description: '读取',
        parameters: {},
        inputSchema: { safeParse: () => ({ success: true, data: {} }) },
        execute: async () => 'bin: dist/main.js',
      });
      const { session, generate, stream } = setup(
        4,
        undefined,
        useStream,
        registry,
        async (goal) => ({
          goal,
          steps: [
            { id: 0, description: '定位入口', status: ETaskStepStatus.PENDING },
          ],
        }),
      );
      stream.mockImplementation(async function* (request) {
        yield { type: EModelEventType.DONE, result: await generate(request) };
      });
      let runId: string | undefined;
      generate
        .mockResolvedValueOnce({
          ...answer(''),
          toolCalls: [{ name: READ_FILE_TOOL_NAME, arguments: {} }],
        })
        .mockImplementationOnce(async (request) => {
          expect(
            request.tools?.some((tool) => tool.name === UPDATE_PLAN_TOOL_NAME),
          ).toBe(true);
          const systemMessages = request.messages.filter(
            ({ role }) => role === EMessageRole.SYSTEM,
          );
          expect(systemMessages).toHaveLength(1);
          expect(systemMessages[0]?.content).toContain(SYSTEM_PROMPT);
          expect(systemMessages[0]?.content).toContain(UPDATE_PLAN_TOOL_NAME);
          return {
            ...answer(''),
            toolCalls: [
              {
                name: UPDATE_PLAN_TOOL_NAME,
                arguments: {
                  operation: EPlanUpdateOperation.SET_STATUS,
                  stepId: 0,
                  status: ETaskStepStatus.COMPLETED,
                  evidence: [{ runId, toolCallId: '1:1' }],
                },
              },
            ],
          };
        })
        .mockResolvedValueOnce(answer('入口为 dist/main.js'));
      await session.startPlan('分析 CLI', (event) => {
        if (event.type === EAgentEventType.RUN_STARTED) {
          runId = event.runId;
        }
      });
      expect(generate.mock.calls[2]?.[0].messages[0]?.content).toContain(
        '"status":"completed"',
      );
      expect(session.plan?.steps[0]?.status).toBe(ETaskStepStatus.COMPLETED);
    },
  );

  it('拒绝同一批工具的证据，下一次请求可用，运行失败时回滚进度', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: READ_FILE_TOOL_NAME,
      description: '读取',
      parameters: {},
      inputSchema: { safeParse: () => ({ success: true, data: {} }) },
      execute: async () => '入口',
    });
    const { session, generate } = setup(
      4,
      undefined,
      undefined,
      registry,
      async (goal) => ({
        goal,
        steps: [
          { id: 0, description: '定位入口', status: ETaskStepStatus.PENDING },
        ],
      }),
    );
    let runId = '';
    const markComplete = (toolCallId: string) => ({
      name: UPDATE_PLAN_TOOL_NAME,
      arguments: {
        operation: EPlanUpdateOperation.SET_STATUS,
        stepId: 0,
        status: ETaskStepStatus.COMPLETED,
        evidence: [{ runId, toolCallId }],
      },
    });
    generate
      .mockResolvedValueOnce(answer('已找到计划'))
      .mockImplementationOnce(async () => ({
        ...answer(''),
        toolCalls: [
          { name: READ_FILE_TOOL_NAME, arguments: {} },
          markComplete('1:1'),
        ],
      }))
      .mockImplementationOnce(async (request) => {
        expect(request.messages.at(-1)?.content).toContain(
          ToolErrorCode.EXECUTION_FAILED,
        );
        expect(request.messages[0]?.content).toContain('"status":"pending"');
        return { ...answer(''), toolCalls: [markComplete('1:1')] };
      })
      .mockImplementationOnce(async (request) => {
        expect(request.messages[0]?.content).toContain('"status":"completed"');
        throw new Error('模拟请求失败');
      });
    await session.startPlan('分析 CLI');
    const committedHistory = session.history;
    await expect(
      session.submit('继续', (event) => {
        if (event.type === EAgentEventType.RUN_STARTED) {
          runId = event.runId;
        }
      }),
    ).rejects.toThrow('模拟请求失败');
    expect(session.plan?.steps[0]?.status).toBe(ETaskStepStatus.PENDING);
    expect(session.history).toEqual(committedHistory);
  });

  it('替换后的最新计划超过预算时，下一次模型请求停止且本轮回滚', async () => {
    const budget = new ContextManager(
      {
        contextWindow: 1500,
        reservedOutputTokens: 0,
        toolDefinitionTokens: 0,
      },
      (message) =>
        message.role === EMessageRole.SYSTEM ? message.content.length : 1,
    );
    const { session, generate } = setup(
      3,
      budget,
      undefined,
      undefined,
      async (goal) => ({
        goal,
        steps: [
          { id: 0, description: '定位入口', status: ETaskStepStatus.PENDING },
        ],
      }),
    );
    generate.mockResolvedValueOnce(answer('已开始')).mockResolvedValueOnce({
      ...answer(''),
      toolCalls: [
        {
          name: UPDATE_PLAN_TOOL_NAME,
          arguments: {
            operation: EPlanUpdateOperation.REPLACE_STEPS,
            steps: [{ description: '替换步骤'.repeat(600) }],
          },
        },
      ],
    });
    await session.startPlan('仓库入口');
    const before = { plan: session.plan, history: session.history };

    await expect(session.submit('补充要求')).rejects.toMatchObject({
      code: EContextErrorCode.BUDGET_EXCEEDED,
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect({ plan: session.plan, history: session.history }).toEqual(before);
  });

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

  it('流式与非流式 maxSteps 后保留完整工具历史，继续时重新计步且结果一致', async () => {
    const toolReply: ModelResult = {
      ...answer('查询中'),
      toolCalls: [{ name: LOOKUP_TOOL, arguments: {} }],
    };
    const finalReply = answer('继续后的回答');
    const expectedFirstHistory = [
      { role: EMessageRole.SYSTEM, content: SYSTEM_PROMPT },
      { role: EMessageRole.USER, content: '调用工具' },
      {
        role: EMessageRole.ASSISTANT,
        content: '查询中',
        toolCalls: [{ name: LOOKUP_TOOL, arguments: {} }],
      },
      {
        role: EMessageRole.TOOL,
        name: LOOKUP_TOOL,
        content: JSON.stringify({ success: true, output: '查到证据' }),
      },
    ];
    const runScenario = async (useStream: boolean) => {
      const registry = new ToolRegistry();
      const execute = vi.fn(async () => '查到证据');
      registry.register({
        name: LOOKUP_TOOL,
        description: '固定查询工具',
        parameters: {},
        inputSchema: { safeParse: () => ({ success: true, data: {} }) },
        execute,
      });
      const { session, generate, stream } = setup(
        1,
        undefined,
        useStream,
        registry,
      );
      generate
        .mockResolvedValueOnce(toolReply)
        .mockResolvedValueOnce(finalReply);
      stream
        .mockImplementationOnce(async function* (): AsyncGenerator<ModelEvent> {
          yield { type: EModelEventType.TEXT_DELTA, text: '查询中' };
          yield { type: EModelEventType.DONE, result: toolReply };
        })
        .mockImplementationOnce(async function* (): AsyncGenerator<ModelEvent> {
          yield { type: EModelEventType.TEXT_DELTA, text: '继续后的' };
          yield { type: EModelEventType.TEXT_DELTA, text: '回答' };
          yield { type: EModelEventType.DONE, result: finalReply };
        });
      const requests = useStream ? stream : generate;
      const first = await session.submit('调用工具');
      expect(first.status).toBe(EAgentStatus.MAX_STEPS);
      expect(first.steps).toBe(1);
      expect(session.history).toEqual(expectedFirstHistory);
      expect(session.state).toBe(ESessionState.IDLE);
      expect(requests).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);

      const second = await session.submit('继续');
      expect(second.status).toBe(EAgentStatus.COMPLETE);
      expect(second.steps).toBe(1);
      expect(requests.mock.calls[1]?.[0].messages).toEqual([
        ...expectedFirstHistory,
        { role: EMessageRole.USER, content: '继续' },
      ]);
      expect(session.history).toEqual([
        ...expectedFirstHistory,
        { role: EMessageRole.USER, content: '继续' },
        { role: EMessageRole.ASSISTANT, content: '继续后的回答' },
      ]);
      expect(session.state).toBe(ESessionState.IDLE);
      expect(requests).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(useStream ? generate : stream).not.toHaveBeenCalled();
      return {
        first,
        second,
        history: session.history,
        requests: requests.mock.calls.map(([request]) => request.messages),
      };
    };
    expect(await runScenario(true)).toEqual(await runScenario(false));
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

  it('流式工具执行期间取消后不继续请求模型，下一轮仍可用', async () => {
    const started = deferred<AbortSignal>();
    const release = deferred<void>();
    const toolFinished = deferred<void>();
    const registry = new ToolRegistry();
    registry.register({
      name: LOOKUP_TOOL,
      description: '等待取消的测试工具',
      parameters: {},
      inputSchema: {
        safeParse: () => ({ success: true, data: {} }),
      },
      async execute(_input, { signal }) {
        started.resolve(signal);
        try {
          await release.promise;
          signal.throwIfAborted();
          return '工具结果';
        } finally {
          toolFinished.resolve();
        }
      },
    });
    const { session, stream, generate } = setup(3, undefined, true, registry);
    stream
      .mockImplementationOnce(async function* (): AsyncGenerator<ModelEvent> {
        yield { type: EModelEventType.DONE, result: answer('已有回答') };
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<ModelEvent> {
        yield {
          type: EModelEventType.DONE,
          result: {
            ...answer('正在查询'),
            toolCalls: [{ name: LOOKUP_TOOL, arguments: {} }],
          },
        };
      })
      .mockImplementationOnce(async function* (): AsyncGenerator<ModelEvent> {
        yield { type: EModelEventType.DONE, result: answer('恢复回答') };
      });
    await session.submit('已有问题');
    const committed = session.history;
    const pending = session.submit('将被取消');
    // 提前挂接拒绝处理，避免取消触发未处理的 Promise rejection。
    const rejected = expect(pending).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
    try {
      const toolSignal = await started.promise;
      const cancelledSignal = stream.mock.calls[1]?.[0].signal;
      expect(toolSignal.aborted).toBe(false);
      session.cancelCurrent();
      expect(toolSignal.aborted).toBe(true);
      expect(cancelledSignal?.aborted).toBe(true);
      expect(session.state).toBe(ESessionState.RUNNING);
      await expect(session.submit('太早提交')).rejects.toHaveProperty(
        'code',
        ESessionErrorCode.BUSY,
      );
      await rejected;
      expect(session.state).toBe(ESessionState.IDLE);
      expect(session.history).toEqual(committed);
      expect(stream).toHaveBeenCalledTimes(2);

      const result = await session.submit('新问题');
      expect(result.status).toBe(EAgentStatus.COMPLETE);
      const next = stream.mock.calls[2]?.[0];
      expect(next?.signal).toBeDefined();
      expect(next?.signal).not.toBe(cancelledSignal);
      expect(next?.signal?.aborted).toBe(false);
      expect(next?.messages).toEqual([
        ...committed,
        { role: EMessageRole.USER, content: '新问题' },
      ]);
      expect(session.history).toEqual([
        ...committed,
        { role: EMessageRole.USER, content: '新问题' },
        { role: EMessageRole.ASSISTANT, content: '恢复回答' },
      ]);
      expect(session.state).toBe(ESessionState.IDLE);
      expect(stream).toHaveBeenCalledTimes(3);
      expect(generate).not.toHaveBeenCalled();
    } finally {
      session.cancelCurrent();
      release.resolve();
      await toolFinished.promise;
      await rejected;
    }
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

  it.each([true, false])(
    '多轮裁剪后预算失败不污染历史，reset 后短输入可恢复（stream=%s）',
    async (useStream) => {
      // 固定估算：按字符计成本，验证预算行为，不依赖真实 tokenizer。
      // 消息预算20；system + 当前短输入可容纳，再加旧完整轮次则放不下。
      const contextManager = new ContextManager(
        { contextWindow: 24, reservedOutputTokens: 3, toolDefinitionTokens: 1 },
        (message) => message.content.length,
      );
      const { session, generate, stream } = setup(3, contextManager, useStream);
      generate.mockResolvedValue(answer('回答'));
      stream.mockImplementation(async function* (): AsyncGenerator<ModelEvent> {
        yield { type: EModelEventType.DONE, result: answer('回答') };
      });
      const requests = useStream ? stream : generate;
      await session.submit('第一轮短问题');
      await session.submit('第二轮短问题');
      expect(requests.mock.calls[1]?.[0].messages).toEqual([
        { role: EMessageRole.SYSTEM, content: SYSTEM_PROMPT },
        { role: EMessageRole.USER, content: '第二轮短问题' },
      ]);
      const committed = session.history;
      expect(committed).toHaveLength(5);

      const oversized = '长'.repeat(21);
      await expect(session.submit(oversized)).rejects.toHaveProperty(
        'code',
        EContextErrorCode.BUDGET_EXCEEDED,
      );
      expect(requests).toHaveBeenCalledTimes(2);
      expect(session.history).toEqual(committed);
      expect(session.state).toBe(ESessionState.IDLE);

      session.reset();
      const initial = [{ role: EMessageRole.SYSTEM, content: SYSTEM_PROMPT }];
      expect(session.history).toEqual(initial);
      // reset 清除历史，但不会使同样放不下的输入变得合法。
      await expect(session.submit(oversized)).rejects.toHaveProperty(
        'code',
        EContextErrorCode.BUDGET_EXCEEDED,
      );
      expect(requests).toHaveBeenCalledTimes(2);
      expect(session.history).toEqual(initial);

      const result = await session.submit('新问题');
      expect(result.status).toBe(EAgentStatus.COMPLETE);
      expect(result.steps).toBe(1);
      expect(requests.mock.calls[2]?.[0]).toMatchObject({
        model: MODEL,
        contextLength: 8192,
        messages: [...initial, { role: EMessageRole.USER, content: '新问题' }],
      });
      expect(session.history).toEqual([
        ...initial,
        { role: EMessageRole.USER, content: '新问题' },
        { role: EMessageRole.ASSISTANT, content: '回答' },
      ]);
      expect(session.state).toBe(ESessionState.IDLE);
      expect(requests).toHaveBeenCalledTimes(3);
      expect(useStream ? generate : stream).not.toHaveBeenCalled();
    },
  );

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
