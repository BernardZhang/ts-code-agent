import { describe, expect, it } from 'vitest';
import { ContextManager, groupMessagesByTurn } from './manager.js';
import { EMessageRole, type ModelMessage } from '../model/messages.js';

const multipleTurnsMessages: ModelMessage[] = [
  {
    role: EMessageRole.SYSTEM,
    content: '你是一个计算器助手',
  },
  {
    role: EMessageRole.SYSTEM,
    content:
      '遇到不是数字的的情况需要将确定的数字先都计算出来，然后询问用户未知参数值',
  },
  {
    role: EMessageRole.USER,
    content: '计算8 + (12 + 30) + c',
  },
  {
    role: EMessageRole.ASSISTANT,
    content: '',
    toolCalls: [{ name: 'add', arguments: { a: 12, b: 30 } }],
  },
  {
    role: EMessageRole.TOOL,
    name: 'add',
    content: '42',
  },
  {
    role: EMessageRole.ASSISTANT,
    content: '',
    toolCalls: [
      {
        name: 'add',
        arguments: { a: 8, b: 42 },
      },
    ],
  },
  {
    role: EMessageRole.TOOL,
    name: 'add',
    content: '50',
  },
  {
    role: EMessageRole.ASSISTANT,
    content: '计算结果 50 + c, 需要用户确认c参数值',
  },
  {
    role: EMessageRole.USER,
    content: 'c = 18',
  },
  {
    role: EMessageRole.ASSISTANT,
    content: '',
    toolCalls: [
      {
        name: 'add',
        arguments: { a: 50, b: 18 },
      },
    ],
  },
  {
    role: EMessageRole.TOOL,
    name: 'add',
    content: '68',
  },
  {
    role: EMessageRole.ASSISTANT,
    content: '结果是 68',
  },
];

describe('ContextManager', () => {
  it('从上下文容量中扣除输出预留和工具定义成本', () => {
    const manager = new ContextManager(
      {
        contextWindow: 1000,
        reservedOutputTokens: 200,
        toolDefinitionTokens: 150,
      },
      () => 10,
    );

    expect(manager.getMessageTokenBudget()).toBe(650);
  });

  it('拒绝为 0 的上下文总容量', () => {
    expect(
      () =>
        new ContextManager(
          {
            contextWindow: 0,
            reservedOutputTokens: 0,
            toolDefinitionTokens: 0,
          },
          () => 10,
        ),
    ).toThrow();
  });

  it('剩余预算上下文容量', () => {
    expect(
      new ContextManager(
        {
          contextWindow: 100,
          reservedOutputTokens: 80,
          toolDefinitionTokens: 20,
        },
        () => 10,
      ).getMessageTokenBudget(),
    ).toBe(0);
  });

  it('获取剩余预算异常', () => {
    expect(() =>
      new ContextManager(
        {
          contextWindow: 100,
          reservedOutputTokens: 80,
          toolDefinitionTokens: 21,
        },
        () => 10,
      ).getMessageTokenBudget(),
    ).toThrow('上下文空间已满');
  });

  it('消息 token 估算值必须是非负的安全整数', () => {
    const contextManager = new ContextManager(
      {
        contextWindow: 4096,
        reservedOutputTokens: 1024,
        toolDefinitionTokens: 1024,
      },
      () => -1,
    );

    expect(() =>
      contextManager.estimateMessageTokens([
        {
          role: EMessageRole.ASSISTANT,
          content: '你好',
        },
      ]),
    ).toThrowError('消息 token 估算值必须是非负的安全整数');
  });

  it('消息能正常分组为系统消息与轮次消息', () => {
    const messageGroups = groupMessagesByTurn(multipleTurnsMessages);
    const { systemMessages, turns } = messageGroups;
    const turnsGroupRoles = turns.map((turn) =>
      turn.map((message) => message.role),
    );

    expect(systemMessages.length).toBe(2);
    expect(turns.length).toBe(2);
    expect(turnsGroupRoles).toEqual([
      [
        EMessageRole.USER,
        EMessageRole.ASSISTANT,
        EMessageRole.TOOL,
        EMessageRole.ASSISTANT,
        EMessageRole.TOOL,
        EMessageRole.ASSISTANT,
      ],
      [
        EMessageRole.USER,
        EMessageRole.ASSISTANT,
        EMessageRole.TOOL,
        EMessageRole.ASSISTANT,
      ],
    ]);
  });

  it('输入只有一条 assistant 消息时，分组应明确报错', () => {
    expect(() =>
      groupMessagesByTurn([
        {
          role: EMessageRole.ASSISTANT,
          content: '你好',
        },
      ]),
    ).toThrow();
  });

  it('上下文消息裁剪，取最近的轮次消息', () => {
    const contextManager = new ContextManager(
      {
        contextWindow: 120,
        reservedOutputTokens: 20,
        toolDefinitionTokens: 20,
      },
      () => 10,
    );
    const messages = contextManager.buildContext(multipleTurnsMessages);
    const { systemMessages, turns } = groupMessagesByTurn(
      multipleTurnsMessages,
    );
    const latestTurn = turns.at(-1) || [];

    expect(messages.length).toBe(6);
    expect(messages.map((msg) => msg.role)).toEqual([
      EMessageRole.SYSTEM,
      EMessageRole.SYSTEM,
      EMessageRole.USER,
      EMessageRole.ASSISTANT,
      EMessageRole.TOOL,
      EMessageRole.ASSISTANT,
    ]);
    expect(messages).toEqual([...systemMessages, ...latestTurn]);
  });

  it('系统消息超出预算token抛异常', () => {
    const contextManager = new ContextManager(
      {
        contextWindow: 100,
        reservedOutputTokens: 40,
        toolDefinitionTokens: 40,
      },
      (message: ModelMessage) => {
        return {
          [EMessageRole.SYSTEM]: 30,
          [EMessageRole.USER]: 10,
          [EMessageRole.ASSISTANT]: 20,
          [EMessageRole.TOOL]: 20,
        }[message.role];
      },
    );

    expect(() =>
      contextManager.buildContext([
        {
          role: EMessageRole.SYSTEM,
          content: '你是一个计算器助手',
        },
        {
          role: EMessageRole.USER,
          content: '计算1 + 2',
        },
      ]),
    ).toThrowError('上下文空间不足以存放系统提示词');
  });

  it('预算token刚刚好', () => {
    const contextManager = new ContextManager(
      {
        contextWindow: 100,
        reservedOutputTokens: 40,
        toolDefinitionTokens: 20,
      },
      (message: ModelMessage) => {
        return {
          [EMessageRole.SYSTEM]: 30,
          [EMessageRole.USER]: 10,
          [EMessageRole.ASSISTANT]: 20,
          [EMessageRole.TOOL]: 20,
        }[message.role];
      },
    );

    expect(
      contextManager.buildContext([
        {
          role: EMessageRole.SYSTEM,
          content: '你是一个计算器助手',
        },
        {
          role: EMessageRole.USER,
          content: '计算1 + 2',
        },
      ]).length,
    ).toBe(2);
  });

  it('预算token不足以存放最新轮次的对话消息则报错', () => {
    const contextManager = new ContextManager(
      {
        contextWindow: 100,
        reservedOutputTokens: 40,
        toolDefinitionTokens: 20,
      },
      (message: ModelMessage) => {
        return {
          [EMessageRole.SYSTEM]: 30,
          [EMessageRole.USER]: 20,
          [EMessageRole.ASSISTANT]: 20,
          [EMessageRole.TOOL]: 20,
        }[message.role];
      },
    );

    expect(() =>
      contextManager.buildContext([
        {
          role: EMessageRole.SYSTEM,
          content: '你是一个计算器助手',
        },
        {
          role: EMessageRole.USER,
          content: '计算1 + 2',
        },
      ]),
    ).toThrowError('必须保留的最近轮次消息超出 token 预算');
  });

  it('上下文消息中没有对话论析消息时需要抛异常', () => {
    const contextManager = new ContextManager(
      {
        contextWindow: 100,
        reservedOutputTokens: 40,
        toolDefinitionTokens: 20,
      },
      (message: ModelMessage) => {
        return {
          [EMessageRole.SYSTEM]: 30,
          [EMessageRole.USER]: 20,
          [EMessageRole.ASSISTANT]: 20,
          [EMessageRole.TOOL]: 20,
        }[message.role];
      },
    );

    expect(() =>
      contextManager.buildContext([
        {
          role: EMessageRole.SYSTEM,
          content: '你是一个计算器助手',
        },
      ]),
    ).toThrowError('没有对话轮次');
  });

  it('遇到放不下的历史轮次就停止，不能跳过去保留更旧的轮次', () => {
    const contextManager = new ContextManager(
      {
        contextWindow: 100,
        reservedOutputTokens: 20,
        toolDefinitionTokens: 20,
      },
      () => 10,
    );
    const messages = contextManager.buildContext([
      {
        role: EMessageRole.SYSTEM,
        content: '你是一个计算器助手',
      },
      {
        role: EMessageRole.USER,
        content: '1+2',
      },
      {
        role: EMessageRole.ASSISTANT,
        content: '',
        toolCalls: [
          {
            name: 'add',
            arguments: { a: 1, b: 2 },
          },
        ],
      },
      {
        role: EMessageRole.TOOL,
        name: 'add',
        content: '3',
      },
      {
        role: EMessageRole.ASSISTANT,
        content: '1+2=3',
      },
      {
        role: EMessageRole.USER,
        content: '1+2+3',
      },
      {
        role: EMessageRole.ASSISTANT,
        content: '',
        toolCalls: [
          {
            name: 'add',
            arguments: { a: 1, b: 2 },
          },
        ],
      },
      {
        role: EMessageRole.TOOL,
        name: 'add',
        content: '3',
      },
      {
        role: EMessageRole.ASSISTANT,
        content: '',
        toolCalls: [
          {
            name: 'add',
            arguments: { a: 3, b: 3 },
          },
        ],
      },
      {
        role: EMessageRole.TOOL,
        name: 'add',
        content: '6',
      },
      {
        role: EMessageRole.ASSISTANT,
        content: '1+2+3=6',
      },
      {
        role: EMessageRole.USER,
        content: '5 + 6',
      },
    ]);

    expect(messages.length).toBe(2);
    expect(messages).toEqual([
      { role: EMessageRole.SYSTEM, content: '你是一个计算器助手' },
      { role: EMessageRole.USER, content: '5 + 6' },
    ]);
  });

  it('裁剪不修改原始历史', () => {
    const before = structuredClone(multipleTurnsMessages);
    const contextManager = new ContextManager(
      {
        contextWindow: 100,
        reservedOutputTokens: 20,
        toolDefinitionTokens: 20,
      },
      () => 10,
    );

    const result = contextManager.buildContext(multipleTurnsMessages);

    expect(multipleTurnsMessages).toEqual(before);
    expect(result).not.toBe(multipleTurnsMessages);
    expect(result.length).toBeLessThan(multipleTurnsMessages.length);
  });
});
