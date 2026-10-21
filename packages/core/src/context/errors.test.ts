import { describe, expect, it } from 'vitest';
import { EMessageRole, type ModelMessage } from '../model/messages.js';
import { ContextError, EContextErrorCode } from './errors.js';
import { ContextManager, groupMessagesByTurn } from './manager.js';

const budget = {
  contextWindow: 10,
  reservedOutputTokens: 0,
  toolDefinitionTokens: 0,
};
const messages: ModelMessage[] = [{ role: EMessageRole.USER, content: '任务' }];

const captureError = (action: () => unknown): ContextError => {
  try {
    action();
  } catch (error) {
    if (!(error instanceof ContextError)) throw error;
    return error;
  }
  throw new Error('预期抛出 ContextError');
};

describe('上下文错误分类', () => {
  it('保留错误类型、名称、错误码和原因', () => {
    const cause = new Error('原因');
    const error = new ContextError(
      EContextErrorCode.INVALID_ESTIMATE,
      '估算失败',
      { cause },
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ContextError');
    expect(error.cause).toBe(cause);
    expect(error.code).toBe(EContextErrorCode.INVALID_ESTIMATE);
  });

  it('区分非法预算配置与有效配置但预算不足', () => {
    expect(
      captureError(
        () => new ContextManager({ ...budget, contextWindow: 0 }, () => 1),
      ).code,
    ).toBe(EContextErrorCode.INVALID_BUDGET);
    expect(
      captureError(() =>
        new ContextManager(
          { ...budget, reservedOutputTokens: 11 },
          () => 1,
        ).getMessageTokenBudget(),
      ).code,
    ).toBe(EContextErrorCode.BUDGET_EXCEEDED);
    expect(
      captureError(() =>
        new ContextManager(budget, () => 11).buildContext(messages),
      ).code,
    ).toBe(EContextErrorCode.BUDGET_EXCEEDED);
  });

  it('非法历史与缺少用户轮次均为历史错误', () => {
    expect(
      captureError(() =>
        groupMessagesByTurn([
          { role: EMessageRole.TOOL, name: 'add', content: '3' },
        ]),
      ).code,
    ).toBe(EContextErrorCode.INVALID_HISTORY);
    expect(
      captureError(() => new ContextManager(budget, () => 1).buildContext([]))
        .code,
    ).toBe(EContextErrorCode.INVALID_HISTORY);
  });

  it.each([-1, 0.5, NaN, Infinity])('拒绝非法估算 %s', (value) => {
    expect(
      captureError(() =>
        new ContextManager(budget, () => value).estimateMessageTokens(messages),
      ).code,
    ).toBe(EContextErrorCode.INVALID_ESTIMATE);
  });

  it('累加溢出归类为估算错误', () => {
    expect(
      captureError(() =>
        new ContextManager(
          budget,
          () => Number.MAX_SAFE_INTEGER,
        ).estimateMessageTokens([...messages, ...messages]),
      ).code,
    ).toBe(EContextErrorCode.INVALID_ESTIMATE);
  });
});
