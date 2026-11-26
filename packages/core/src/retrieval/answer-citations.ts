import type { EvidenceCitation } from './evidence-context.js';

export enum EAnswerCitationIssueCode {
  EMPTY_ANSWER = 'empty_answer',
  NO_EVIDENCE = 'no_evidence',
  MISSING_CITATION = 'missing_citation',
  UNKNOWN_CITATION = 'unknown_citation',
}

export interface AnswerCitationIssue {
  readonly code: EAnswerCitationIssueCode;
  readonly citationId?: string;
}

export interface AnswerCitationValidation {
  /** 仅表示本轮引用编号校验通过，正文对证据的忠实性需另行评测。 */
  readonly valid: boolean;
  readonly citations: readonly EvidenceCitation[];
  readonly issues: readonly AnswerCitationIssue[];
}

const SOURCE_ID = /^S[1-9]\d*$/u;
const ANSWER_CITATION = /\[(S\d+)\]/gu;

/**
 * 校验回答中的 [S数字]，仅接受本轮真正送入模型的证据映射。
 * 返回引用首次出现顺序；调用方检查 valid 后再将回答展示为已验证结果。
 */
export function validateAnswerCitations(
  answer: string,
  availableSources: readonly EvidenceCitation[],
): AnswerCitationValidation {
  const sources = new Map<string, EvidenceCitation>();
  for (const source of availableSources) {
    if (!SOURCE_ID.test(source.id) || sources.has(source.id)) {
      throw new TypeError('本轮证据编号必须合法且唯一。');
    }
    sources.set(source.id, source);
  }

  const issues: AnswerCitationIssue[] = [];
  const citations: EvidenceCitation[] = [];
  if (!answer.trim()) {
    issues.push({ code: EAnswerCitationIssueCode.EMPTY_ANSWER });
  }
  if (sources.size === 0) {
    issues.push({ code: EAnswerCitationIssueCode.NO_EVIDENCE });
  }

  const seen = new Set<string>();
  for (const match of answer.matchAll(ANSWER_CITATION)) {
    const id = match[1];
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const source = sources.get(id);
    if (source === undefined) {
      issues.push({
        code: EAnswerCitationIssueCode.UNKNOWN_CITATION,
        citationId: id,
      });
    } else {
      citations.push({ ...source, headingPath: [...source.headingPath] });
    }
  }
  if (answer.trim() && sources.size > 0 && seen.size === 0) {
    issues.push({ code: EAnswerCitationIssueCode.MISSING_CITATION });
  }
  return { valid: issues.length === 0, citations, issues };
}
