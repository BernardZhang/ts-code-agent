import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRunner,
  EMessageRole,
  EModelEventType,
  ETaskStepStatus,
  ModelError,
  ModelErrorCode,
  ToolExecutor,
  ToolRegistry,
  type ModelProvider,
  type ModelResult,
} from '@ts-code-agent/core';
import { generateTaskPlan } from '../commands/plan-demo.js';
import { AgentSession, ESessionState } from './agent-session.js';
import { ConsoleSession, ESessionCommand } from './console-session.js';

import {
  EPlanUpdateOperation,
  UPDATE_PLAN_TOOL_NAME,
} from './update-plan-tool.js';

const answer = (text: string): ModelResult => ({ text, usage: {} });
function setup(
  terminal = false,
  maxSteps = 3,
  stream?: ModelProvider['stream'],
  planning = false,
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  let stdout = '';
  let stderr = '';
  output.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  error.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const generate = vi.fn<ModelProvider['generate']>();
  const provider: ModelProvider = {
    capabilities: { structuredOutput: planning },
    generate,
    stream:
      stream ??
      (() => {
        throw new Error('不使用流式生成');
      }),
  };
  const session = new AgentSession(
    new AgentRunner(provider, new ToolExecutor(new ToolRegistry())),
    {
      request: { model: 'console-test' },
      systemPrompt: '规则',
      maxSteps,
      ...(planning
        ? {
            generatePlan: (goal, signal) =>
              generateTaskPlan(
                provider,
                { model: 'console-test', signal },
                goal,
              ),
          }
        : {}),
      stream: stream !== undefined,
    },
  );
  const consoleSession = new ConsoleSession(session, {
    input,
    output,
    error,
    terminal,
  });
  const done = consoleSession.run();
  return {
    input,
    output,
    error,
    session,
    generate,
    done,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('ConsoleSession', () => {
  it('纯计算可以显式报告结果，无需仓库工具证据', async () => {
    const s = setup(false, 3, undefined, true);
    s.generate
      .mockResolvedValueOnce(
        answer(
          JSON.stringify({
            goal: '计算 1+2+3+c',
            steps: ['计算 c=1', '计算 c=2'],
          }),
        ),
      )
      .mockResolvedValueOnce({
        ...answer(''),
        toolCalls: ['1+2+3+1=7', '1+2+3+2=8'].map((summary, stepId) => ({
          name: UPDATE_PLAN_TOOL_NAME,
          arguments: {
            operation: EPlanUpdateOperation.SET_STATUS,
            stepId,
            status: ETaskStepStatus.COMPLETED,
            summary,
          },
        })),
      })
      .mockResolvedValueOnce(answer('c=1 时是 7，c=2 时是 8。'));
    try {
      s.input.write('/plan 计算 1+2+3+c，c 为 1 或 2\n');
      await vi.waitFor(() => expect(s.stderr()).toContain('计划进度：2/2'));
      expect(s.stderr()).toContain('模型报告 2 步');
      expect(s.session.plan?.steps.map(({ status }) => status)).toEqual([
        ETaskStepStatus.MODEL_REPORTED,
        ETaskStepStatus.MODEL_REPORTED,
      ]);
      expect(
        s.session.plan?.steps.some(
          ({ status }) => status === ETaskStepStatus.COMPLETED,
        ),
      ).toBe(false);
      expect(s.session.history.at(-2)?.content).toContain('1+2+3+2=8');
    } finally {
      s.input.end();
      await s.done;
    }
  });

  it('生成计划后立即执行，下一轮继续使用计划，重置后清空', async () => {
    const s = setup(false, 3, undefined, true);
    s.generate
      .mockResolvedValueOnce(
        answer(JSON.stringify({ goal: '分析 CLI', steps: ['定位入口'] })),
      )
      .mockResolvedValue(answer('已回答'));
    try {
      s.input.write('/plan   分析 CLI\n');
      await vi.waitFor(() => expect(s.stderr()).toContain('定位入口'));
      const [planningRequest, executionRequest] = s.generate.mock.calls.map(
        ([request]) => request,
      );
      expect(planningRequest?.jsonSchema).toBeDefined();
      expect(executionRequest?.signal).toBe(planningRequest?.signal);
      expect(executionRequest?.messages).toEqual(
        expect.arrayContaining([
          { role: EMessageRole.USER, content: '分析 CLI' },
          expect.objectContaining({
            role: EMessageRole.SYSTEM,
            content: expect.stringContaining('定位入口'),
          }),
        ]),
      );
      expect(
        s.session.history.filter(
          (message) => message.role === EMessageRole.SYSTEM,
        ),
      ).toHaveLength(1);
      s.input.write('继续\n');
      await vi.waitFor(() => expect(s.session.history).toHaveLength(5));
      expect(s.generate.mock.calls[2]?.[0].messages).toContainEqual(
        expect.objectContaining({
          role: EMessageRole.SYSTEM,
          content: expect.stringContaining('定位入口'),
        }),
      );
      s.input.write('/reset\n');
      expect(s.session.plan).toBeUndefined();
    } finally {
      s.input.end();
      await s.done;
    }
  });

  it('新计划执行失败时保留已提交的计划与历史', async () => {
    const s = setup(false, 3, undefined, true);
    s.generate
      .mockResolvedValueOnce(
        answer(JSON.stringify({ goal: '原计划', steps: ['旧步骤'] })),
      )
      .mockResolvedValueOnce(answer('已回答'))
      .mockResolvedValueOnce(
        answer(JSON.stringify({ goal: '新计划', steps: ['新步骤'] })),
      )
      .mockRejectedValueOnce(new Error('执行失败'));
    try {
      s.input.write('/plan 原计划\n');
      await vi.waitFor(() => expect(s.session.plan?.goal).toBe('原计划'));
      const history = s.session.history;
      s.input.write('/plan 新计划\n');
      await vi.waitFor(() => expect(s.stderr()).toContain('执行失败'));
      expect(s.session.plan?.goal).toBe('原计划');
      expect(s.session.history).toEqual(history);
    } finally {
      s.input.end();
      await s.done;
    }
  });

  it('默认流式执行仍先使用结构化生成建立计划', async () => {
    const stream = vi.fn<ModelProvider['stream']>(async function* () {
      yield { type: EModelEventType.TEXT_DELTA, text: '流式回答' };
      yield { type: EModelEventType.DONE, result: answer('流式回答') };
    });
    const s = setup(false, 3, stream, true);
    s.generate.mockResolvedValueOnce(
      answer(JSON.stringify({ goal: '分析 CLI', steps: ['定位入口'] })),
    );
    try {
      s.input.write('/plan 分析 CLI\n');
      await vi.waitFor(() => expect(s.stderr()).toContain('定位入口'));
      expect(s.generate).toHaveBeenCalledTimes(1);
      expect(stream).toHaveBeenCalledTimes(1);
      expect(s.stdout()).toContain('流式回答');
    } finally {
      s.input.end();
      await s.done;
    }
  });

  it('空计划命令不发起模型请求', async () => {
    const s = setup(false, 3, undefined, true);
    try {
      s.input.write('/plan  \n');
      expect(s.stderr()).toContain('/plan <目标>');
      expect(s.generate).not.toHaveBeenCalled();
    } finally {
      s.input.end();
      await s.done;
    }
  });

  it.each(['', '部分文字', '部分文字\n'])(
    '流式取消和失败后的排版与历史回滚：%j',
    async (text) => {
      for (const failure of [
        new Error('模拟断流'),
        new ModelError(ModelErrorCode.CANCELLED, '取消'),
      ]) {
        const s = setup(false, 1, async function* () {
          yield { type: EModelEventType.TEXT_DELTA, text };
          throw failure;
        });
        s.input.write('问题\n');
        await vi.waitFor(() => expect(s.stderr()).toContain('本轮对话未保存'));
        const newline = text && !text.endsWith('\n') ? '\n' : '';
        expect(s.stdout()).toBe(`> ${text}${newline}> `);
        expect(s.stderr().includes('以上输出不完整')).toBe(text.length > 0);
        expect(s.stderr()).toContain('工具操作不会回滚');
        expect(s.session.history).toHaveLength(1);
        s.input.end();
        await s.done;
      }
    },
  );

  it.each(['', '完整文字', '完整文字\n'])(
    '流式正常完成只补必要换行，忽略空增量：%j',
    async (text) => {
      const s = setup(false, 1, async function* () {
        yield { type: EModelEventType.TEXT_DELTA, text };
        yield { type: EModelEventType.TEXT_DELTA, text: '' };
        yield { type: EModelEventType.DONE, result: answer(text) };
      });
      s.input.write('问题\n');
      await vi.waitFor(() => expect(s.session.history).toHaveLength(3));
      const newline = text && !text.endsWith('\n') ? '\n' : '';
      expect(s.stdout()).toBe(`> ${text}${newline}> `);
      expect(s.stderr()).toBe('');
      s.input.end();
      await s.done;
    },
  );

  it('流式步数耗尽补换行并说明历史已保存', async () => {
    const s = setup(false, 1, async function* () {
      yield { type: EModelEventType.TEXT_DELTA, text: '正在查询' };
      yield {
        type: EModelEventType.DONE,
        result: {
          ...answer('正在查询'),
          toolCalls: [{ name: 'missing-tool', arguments: {} }],
        },
      };
    });
    s.input.write('问题\n');
    await vi.waitFor(() => expect(s.stderr()).toContain('步数上限'));
    expect(s.stdout()).toBe('> 正在查询\n> ');
    expect(s.stderr()).toContain('以上输出不完整');
    expect(s.stderr()).toContain('完整调用历史已保存');
    expect(s.stderr()).not.toContain('本轮对话未保存');
    expect(s.session.history.at(-1)?.role).toBe(EMessageRole.TOOL);
    s.input.end();
    await s.done;
  });

  it('多行内容只在 send 后作为一条消息提交，保留空行、缩进和命令文本', async () => {
    const s = setup();
    s.generate.mockResolvedValue(answer('多行回答'));
    const lines = [
      '搜索代码：',
      'function example() {',
      '',
      '  return 1;',
      '}',
      '/reset',
      '/exit',
    ];
    s.input.write(`${ESessionCommand.MULTILINE}\n${lines.join('\n')}\n`);
    expect(s.session.history).toHaveLength(1);
    expect(s.generate).not.toHaveBeenCalled();
    s.input.write(`${ESessionCommand.SEND}\n`);
    await vi.waitFor(() => expect(s.stdout()).toContain('多行回答'));
    expect(s.session.history[1]).toEqual({
      role: EMessageRole.USER,
      content: lines.join('\n'),
    });
    expect(s.generate).toHaveBeenCalledTimes(1);
    s.input.write(`${ESessionCommand.EXIT}\n`);
    await s.done;
  });

  it('空白多行不请求模型，保留输入模式供继续补充', async () => {
    const s = setup();
    s.generate.mockResolvedValue(answer('补充回答'));
    s.input.write(
      `${ESessionCommand.MULTILINE}\n  \n\n${ESessionCommand.SEND}\n`,
    );
    expect(s.generate).not.toHaveBeenCalled();
    expect(s.stderr()).toContain('输入不能为空');
    s.input.write(`补充内容\n${ESessionCommand.SEND}\n`);
    await vi.waitFor(() => expect(s.stdout()).toContain('补充回答'));
    expect(s.session.history[1]?.content).toBe('  \n\n补充内容');
    s.input.end();
    await s.done;
  });

  it('cancel 放弃草稿，下一条普通输入没有旧内容', async () => {
    const s = setup();
    s.generate.mockResolvedValue(answer('普通回答'));
    s.input.write(
      `${ESessionCommand.MULTILINE}\n旧草稿\n${ESessionCommand.CANCEL}\n新问题\n`,
    );
    await vi.waitFor(() => expect(s.stdout()).toContain('普通回答'));
    expect(s.session.history[1]?.content).toBe('新问题');
    s.input.end();
    await s.done;
  });

  it('多行 EOF 放弃草稿，不请求模型', async () => {
    const s = setup();
    s.input.end(`${ESessionCommand.MULTILINE}\n未提交的代码\n`);
    await s.done;
    expect(s.session.state).toBe(ESessionState.CLOSED);
    expect(s.generate).not.toHaveBeenCalled();
  });

  it('多行 Ctrl+C 只清除草稿和未回车文字，仍可输入新问题', async () => {
    const s = setup(true);
    s.generate.mockResolvedValue(answer('恢复回答'));
    s.input.write(`${ESessionCommand.MULTILINE}\r旧草稿\r未回车文字`);
    s.input.write('\x03');
    expect(s.session.state).toBe(ESessionState.IDLE);
    s.input.write('新问题\r');
    await vi.waitFor(() => expect(s.stdout()).toContain('恢复回答'));
    expect(s.session.history[1]?.content).toBe('新问题');
    s.input.write('\x03');
    await s.done;
  });

  it('忽略空白，连续两轮输出回答，reset 后只携带新问题，exit 结束', async () => {
    const s = setup();
    s.generate.mockResolvedValue(answer('回答完成'));
    s.input.write('  \n');
    expect(s.session.history).toHaveLength(1);
    s.input.write('第一问\n');
    await vi.waitFor(() => expect(s.stdout()).toContain('回答完成'));
    s.input.write('第二问\n');
    await vi.waitFor(() => expect(s.session.history).toHaveLength(5));
    s.input.write('/reset\n新问题\n');
    await vi.waitFor(() => expect(s.session.history).toHaveLength(3));
    expect(s.session.history[1]).toEqual({
      role: EMessageRole.USER,
      content: '新问题',
    });
    s.input.write('/exit\n');
    await s.done;
    expect(s.session.state).toBe(ESessionState.CLOSED);
  });

  it.each(['EOF', '/exit'])(
    '忙碌期间输入和 reset 不排队，%s 等待旧任务收尾',
    async (exit) => {
      const s = setup();
      let release!: (result: ModelResult) => void;
      s.generate.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      s.input.write('第一问\n');
      s.input.write(`不应执行\n/reset\n${ESessionCommand.MULTILINE}\n`);
      expect(s.stderr()).toContain('当前任务尚未结束');
      let finished = false;
      void s.done.then(() => {
        finished = true;
      });
      if (exit === 'EOF') {
        s.input.end();
      } else {
        s.input.write('/exit\n');
      }
      await vi.waitFor(() =>
        expect(s.session.state).toBe(ESessionState.CLOSED),
      );
      await Promise.resolve();
      expect(finished).toBe(false);
      release(answer('不应显示的旧回答'));
      await s.done;
      expect(s.session.history).toHaveLength(1);
      expect(s.stdout()).not.toContain('不应显示的旧回答');
      expect(s.input.listenerCount('data')).toBe(0);
    },
  );

  it('输入流失败时关闭会话并显示错误', async () => {
    const s = setup();
    s.input.destroy(new Error('读取失败'));
    await s.done;
    expect(s.stderr()).toContain('终端输入失败：读取失败');
    expect(s.session.state).toBe(ESessionState.CLOSED);
  });

  it('运行时 Ctrl+C 取消后可继续，空闲时 Ctrl+C 退出', async () => {
    const s = setup(true);
    s.generate
      .mockImplementationOnce(
        (request) =>
          new Promise((_, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(request.signal?.reason),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(answer('新回答'));
    s.input.write('旧问题\r');
    s.input.write('\x03');
    await vi.waitFor(() => expect(s.session.state).toBe(ESessionState.IDLE));
    expect(s.stderr()).toContain('当前任务已取消');
    s.input.write('新问题\r');
    await vi.waitFor(() => expect(s.stdout()).toContain('新回答'));
    s.input.write('\x03');
    await s.done;
    expect(s.session.history).toHaveLength(3);
  });

  it('Provider 失败后可继续，步数耗尽明确提示未完成', async () => {
    const s = setup(false, 1);
    s.generate
      .mockRejectedValueOnce(new Error('连接失败'))
      .mockResolvedValueOnce({
        ...answer(''),
        toolCalls: [{ name: 'missing-tool', arguments: {} }],
      });
    s.input.write('失败问题\n');
    await vi.waitFor(() => expect(s.stderr()).toContain('连接失败'));
    s.input.write('工具问题\n');
    await vi.waitFor(() => expect(s.stderr()).toContain('步数上限'));
    expect(s.stderr()).toContain('尚未完成');
    s.input.end();
    await s.done;
  });
});
