import { createHash } from 'node:crypto';
import { parseDocument } from './parse-document.js';
import { chunkDocument } from './chunk-document.js';
import {
  EDocumentFormat,
  type Document,
  type ParsedDocument,
} from './types.js';

const DEFAULT_MAX_CHUNK_CODE_POINTS = 800;

export interface IngestDocumentOptions {
  readonly corpusId: string;
  /** 来源由调用方确定，可以是相对路径、URL 或其他稳定的来源标识。 */
  readonly sourcePath: string;
  readonly format: EDocumentFormat;
  readonly text: string;
  readonly maxChunkCodePoints?: number;
  readonly signal?: AbortSignal;
}

/** 将已有正文转换为可索引文档，不访问文件系统。 */
export function ingestDocument(options: IngestDocumentOptions): ParsedDocument {
  const {
    corpusId,
    sourcePath,
    format,
    signal,
    maxChunkCodePoints = DEFAULT_MAX_CHUNK_CODE_POINTS,
  } = options;
  signal?.throwIfAborted();
  if (!corpusId.trim() || !sourcePath.trim()) {
    throw new TypeError('资料集和文档来源不能为空。');
  }
  if (format !== EDocumentFormat.MARKDOWN && format !== EDocumentFormat.TEXT) {
    throw new TypeError('不支持的文档格式。');
  }
  if (!Number.isSafeInteger(maxChunkCodePoints) || maxChunkCodePoints < 1) {
    throw new RangeError('分块上限必须为正整数。');
  }

  // 各种来源使用相同规范化规则，保证内容版本和 UTF-16 坐标一致。
  const text = options.text.replace(/^\uFEFF/u, '').replace(/\r\n?/g, '\n');
  const document: Document = {
    corpusId,
    sourcePath,
    format,
    text,
    documentId: createHash('sha256')
      .update(JSON.stringify([corpusId, sourcePath]))
      .digest('hex'),
    contentHash: createHash('sha256').update(text).digest('hex'),
  };
  if (!text.trim()) {
    return { document, chunks: [] };
  }
  const sections = parseDocument(text, format);
  signal?.throwIfAborted();
  const chunks = chunkDocument(document, sections, maxChunkCodePoints, signal);
  signal?.throwIfAborted();
  return { document, chunks };
}
