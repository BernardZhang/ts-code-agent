import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath } from '../workspace/workspace.js';
import {
  ingestDocument,
  EDocumentFormat,
  type TextFileReader,
} from '@ts-code-agent/core';
import {
  EIngestErrorCode,
  type IngestDocumentOptions,
  type IngestDocumentResult,
} from './types.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_CODE_POINTS = 800;
const DOCUMENT_FORMAT_BY_EXTENSION: ReadonlyMap<string, EDocumentFormat> =
  new Map([
    ['.md', EDocumentFormat.MARKDOWN],
    ['.markdown', EDocumentFormat.MARKDOWN],
    ['.txt', EDocumentFormat.TEXT],
  ]);

class IngestError extends Error {
  constructor(
    readonly code: (typeof EIngestErrorCode)[keyof typeof EIngestErrorCode],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'IngestError';
  }
}

/**
 * 导入单个工作区文件。来源路径使用真实路径相对于工作区的位置，
 * 使指向同一文件的路径别名生成相同的逻辑文档 ID。
 */
export async function ingestWorkspaceDocument(
  options: IngestDocumentOptions,
  readTextFile: TextFileReader,
): Promise<IngestDocumentResult> {
  const {
    rootPath,
    sourcePath,
    corpusId,
    maxBytes = DEFAULT_MAX_BYTES,
    maxChunkCodePoints = DEFAULT_MAX_CHUNK_CODE_POINTS,
    signal,
  } = options;

  checkCancellation(signal);
  if (
    path.isAbsolute(sourcePath) ||
    !sourcePath.trim() ||
    sourcePath.includes('\0')
  ) {
    throw new IngestError(
      EIngestErrorCode.INVALID_PATH,
      '请输入工作区内的相对文件路径。',
    );
  }
  if (!corpusId.trim()) {
    throw new TypeError('资料集标识不能为空。');
  }
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_READ_BYTES
  ) {
    throw new RangeError(`读取上限必须为 1 到 ${MAX_READ_BYTES} 之间的整数。`);
  }
  if (!Number.isSafeInteger(maxChunkCodePoints) || maxChunkCodePoints < 1) {
    throw new RangeError('分块上限必须为正整数。');
  }

  try {
    const root = await realpath(rootPath);
    const target = await resolveWorkspacePath(root, sourcePath).catch(
      (cause: unknown) => {
        if (cause instanceof RangeError) {
          throw new IngestError(
            EIngestErrorCode.INVALID_PATH,
            '请求路径超出工作区范围。',
            { cause },
          );
        }
        throw cause;
      },
    );
    checkCancellation(signal);

    const relativePath = path.relative(root, target).split(path.sep).join('/');
    const extension = path.extname(relativePath).toLowerCase();
    const format = DOCUMENT_FORMAT_BY_EXTENSION.get(extension);
    if (format === undefined) {
      throw new IngestError(
        EIngestErrorCode.UNSUPPORTED_FORMAT,
        '仅支持 Markdown 和 TXT 文档。',
      );
    }

    const text = await readTextFile(target, {
      maxBytes,
      ...(signal ? { signal } : {}),
    });
    checkCancellation(signal);
    return ingestDocument({
      corpusId,
      sourcePath: relativePath,
      text,
      format,
      maxChunkCodePoints,
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    checkCancellation(signal);
    throw cause;
  }
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new IngestError(EIngestErrorCode.CANCELLED, '文档导入已取消。', {
      cause: signal.reason,
    });
  }
}
