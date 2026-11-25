import { expect, it } from 'vitest';
import {
  validateAnswerCitations,
  EAnswerCitationIssueCode,
} from './answer-citations.js';
import type { EvidenceCitation } from './evidence-context.js';

function source(id: string): EvidenceCitation {
  return {
    id,
    documentId: 'doc',
    contentHash: 'version',
    sourcePath: 'guide.md',
    chunkId: id,
    startOffset: 0,
    endOffset: 2,
    startLine: 1,
    endLine: 1,
    headingPath: ['指南'],
  };
}

it('按回答首次引用顺序映射来源，重复编号只展示一次', () => {
  const sources = [source('S1'), source('S2')];
  const result = validateAnswerCitations(
    '先取消[S2]，再清理[S1]。重复[S2]',
    sources,
  );
  expect(result).toEqual({
    valid: true,
    citations: [sources[1], sources[0]],
    issues: [],
  });
});

it('不存在的引用导致校验失败，保留已知引用和全部未知编号', () => {
  const result = validateAnswerCitations(
    '有依据[S1]，不存在[S2]和[S99]，重复[S2]',
    [source('S1')],
  );
  expect(result.valid).toBe(false);
  expect(result.citations).toEqual([source('S1')]);
  expect(result.issues).toEqual([
    { code: EAnswerCitationIssueCode.UNKNOWN_CITATION, citationId: 'S2' },
    { code: EAnswerCitationIssueCode.UNKNOWN_CITATION, citationId: 'S99' },
  ]);
});

it('有证据但回答没有引用时失败，空回答单独报告', () => {
  expect(
    validateAnswerCitations('没有引用的结论', [source('S1')]).issues,
  ).toEqual([{ code: EAnswerCitationIssueCode.MISSING_CITATION }]);
  expect(validateAnswerCitations(' \n ', [source('S1')]).issues).toEqual([
    { code: EAnswerCitationIssueCode.EMPTY_ANSWER },
  ]);
});

it('没有本轮证据时不将模型回答视为通过验证', () => {
  expect(validateAnswerCitations('资料不足。', []).issues).toEqual([
    { code: EAnswerCitationIssueCode.NO_EVIDENCE },
  ]);
  const result = validateAnswerCitations('伪造来源[S1]', []);
  expect(result.valid).toBe(false);
  expect(result.citations).toEqual([]);
  expect(result.issues).toContainEqual({
    code: EAnswerCitationIssueCode.UNKNOWN_CITATION,
    citationId: 'S1',
  });
});

it('编号严格匹配，不将 S01 或 S0 自动转换成已有编号', () => {
  const result = validateAnswerCitations('来源[S01] [S0]', [source('S1')]);
  expect(result.valid).toBe(false);
  expect(result.issues.map((issue) => issue.citationId)).toEqual(['S01', 'S0']);
});

it('重复或非法的可用编号属于调用方契约错误', () => {
  expect(() =>
    validateAnswerCitations('[S1]', [source('S1'), source('S1')]),
  ).toThrow(TypeError);
  expect(() => validateAnswerCitations('[S1]', [source('S01')])).toThrow(
    TypeError,
  );
});
