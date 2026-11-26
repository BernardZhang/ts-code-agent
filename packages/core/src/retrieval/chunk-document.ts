import { createHash } from 'node:crypto';
import type { Chunk, Document, DocumentSection } from './types.js';

const CHUNK_RULE_VERSION = 1;
const WHITESPACE = /\s/u;

/**
 * 优先沿结构、换行或空白切分，必要时按 Unicode 码点硬切。
 * 长度上限按码点计数，来源偏移按 UTF-16 计数，保证切片可用 slice 复原。
 * 片段 ID 由文档 ID、内容版本、分块规则版本与片段范围确定。
 */
export function chunkDocument(
  document: Document,
  sections: readonly DocumentSection[],
  maxCodePoints: number,
  signal?: AbortSignal,
): readonly Chunk[] {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 1) {
    throw new RangeError('分块上限必须为正整数。');
  }

  const chunks: Chunk[] = [];
  const { text } = document;
  // 区段按原文顺序处理，行号游标只前进，避免对每个片段重扫全文。
  let lineOffset = 0;
  let line = 1;
  const lineAt = (offset: number) => {
    while (lineOffset < offset) {
      if (text[lineOffset] === '\n') {
        line++;
      }
      lineOffset++;
    }
    return line;
  };

  let previousEnd = 0;
  for (const section of sections) {
    signal?.throwIfAborted();
    const { startOffset, endOffset } = section;
    if (
      !Number.isSafeInteger(startOffset) ||
      !Number.isSafeInteger(endOffset) ||
      startOffset < previousEnd ||
      endOffset < startOffset ||
      endOffset > text.length ||
      splitsSurrogatePair(text, startOffset) ||
      splitsSurrogatePair(text, endOffset)
    ) {
      throw new RangeError('区段必须按顺序排列，且包含合法的原文范围。');
    }
    previousEnd = endOffset;

    let start = startOffset;
    while (start < endOffset) {
      signal?.throwIfAborted();
      let end = start;
      let count = 0;
      let newlineBoundary = start;
      let whitespaceBoundary = start;
      while (end < endOffset && count < maxCodePoints) {
        signal?.throwIfAborted();
        const codePoint = text.codePointAt(end);
        // end 始终位于有效区间；码点大于 0xffff 时跨过整个代理对。
        const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
        const character = text.slice(end, end + width);
        end += width;
        count++;
        if (character === '\n') {
          newlineBoundary = end;
        }
        if (WHITESPACE.test(character)) {
          whitespaceBoundary = end;
        }
      }

      // 区段已完整放下时直接收尾，超限才回退到自然边界。
      if (end < endOffset) {
        end =
          newlineBoundary > start
            ? newlineBoundary
            : whitespaceBoundary > start
              ? whitespaceBoundary
              : end;
      }
      const chunkText = text.slice(start, end);
      // 纯空白不能向量化；仍前进原文游标，避免死循环并保留后续来源坐标。
      // 有效片段保留原始空白，ordinal 仅按实际输出数量连续编号。
      if (!chunkText.trim()) {
        start = end;
        continue;
      }
      const startLine = lineAt(start);
      const endLine = lineAt(end - 1);
      chunks.push({
        startOffset: start,
        endOffset: end,
        headingPath: [...section.headingPath],
        documentId: document.documentId,
        ordinal: chunks.length,
        text: chunkText,
        startLine,
        endLine,
        chunkId: createHash('sha256')
          .update(
            JSON.stringify([
              document.documentId,
              document.contentHash,
              CHUNK_RULE_VERSION,
              maxCodePoints,
              start,
              end,
            ]),
          )
          .digest('hex'),
      });
      start = end;
    }
  }
  return chunks;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}
