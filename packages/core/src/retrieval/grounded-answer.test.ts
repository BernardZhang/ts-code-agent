import { ModelErrorCode } from '../model/errors.js';
import { expect, it, vi } from 'vitest';
import { ERagAnswerStatus, generateGroundedAnswer } from './grounded-answer.js';
import type { RetrievalHit } from './hybrid-search.js';
import type { ModelMessage } from '../model/messages.js';

const hit: RetrievalHit = {
  documentId: 'doc',
  sourcePath: 'guide.md',
  contentHash: 'v1',
  chunk: {
    chunkId: 'chunk',
    text: '取消后清理监听器',
    ordinal: 0,
    startOffset: 0,
    endOffset: 8,
    startLine: 1,
    endLine: 1,
    headingPath: [],
  },
};
const options = {
  model: 'test',
  contextLength: 10000,
  reservedOutputTokens: 1000,
  estimateMessageTokens: (message: ModelMessage) =>
    JSON.stringify(message).length,
};
const provider = (answer = '取消后清理监听器。[S1]') => ({
  capabilities: { structuredOutput: true },
  generate: vi.fn().mockResolvedValue({
    text: JSON.stringify({ answer, evidenceSufficient: true }),
    usage: {},
  }),
});

it('串联预算内上下文、生成和引用校验，保留来源版本', async () => {
  const model = provider();
  const result = await generateGroundedAnswer(
    '如何取消？',
    [hit],
    options,
    model,
  );
  expect(result.status).toBe(ERagAnswerStatus.ANSWERED);
  expect(result.citations[0]).toMatchObject({
    id: 'S1',
    chunkId: 'chunk',
    contentHash: 'v1',
  });
  const request = model.generate.mock.calls[0]?.[0];
  expect(request.messages[1].content).toContain('[S1]');
  expect(result.estimatedInputTokens).toBe(
    request.messages.reduce(
      (sum: number, message: ModelMessage) =>
        sum + options.estimateMessageTokens(message),
      0,
    ),
  );
  expect(
    result.estimatedInputTokens + options.reservedOutputTokens,
  ).toBeLessThanOrEqual(options.contextLength);
});

it('没有候选或证据装不下时不调用生成模型', async () => {
  const model = provider();
  expect(
    (await generateGroundedAnswer('问题', [], options, model)).status,
  ).toBe(ERagAnswerStatus.INSUFFICIENT_EVIDENCE);
  const small = {
    ...options,
    estimateMessageTokens: () => 100,
    contextLength: 1200,
  };
  expect(
    (
      await generateGroundedAnswer(
        '问题',
        [hit],
        {
          ...small,
          estimateMessageTokens: (message) =>
            message.content.includes('chunkId') ? 101 : 100,
        },
        model,
      )
    ).status,
  ).toBe(ERagAnswerStatus.INSUFFICIENT_EVIDENCE);
  expect(model.generate).not.toHaveBeenCalled();
});

it('未知引用和缺失引用不返回模型原文', async () => {
  for (const answer of ['虚构结论[S99]', '缺失引用']) {
    const result = await generateGroundedAnswer(
      '问题',
      [hit],
      options,
      provider(answer),
    );
    expect(result.status).toBe(ERagAnswerStatus.INVALID_CITATIONS);
    expect(result.answer).not.toBe(answer);
    expect(result.citations).toEqual([]);
    expect(result.issues.length).toBeGreaterThan(0);
  }
});

it('模型判断证据不足时返回拒答', async () => {
  const model = provider();
  model.generate.mockResolvedValue({
    text: JSON.stringify({ answer: '猜测', evidenceSufficient: false }),
    usage: {},
  });
  expect(
    (await generateGroundedAnswer('问题', [hit], options, model)).status,
  ).toBe(ERagAnswerStatus.INSUFFICIENT_EVIDENCE);
});

it('非法响应、预算和取消明确失败', async () => {
  const model = provider();
  model.generate.mockResolvedValue({ text: 'not-json', usage: {} });
  await expect(
    generateGroundedAnswer('问题', [hit], options, model),
  ).rejects.toMatchObject({ code: ModelErrorCode.JSON });
  await expect(
    generateGroundedAnswer(
      '问题',
      [hit],
      {
        ...options,
        contextLength: 1,
      },
      model,
    ),
  ).rejects.toThrow();
  await expect(
    generateGroundedAnswer(
      '问题',
      [hit],
      {
        ...options,
        signal: AbortSignal.abort(),
      },
      model,
    ),
  ).rejects.toThrow();
});
