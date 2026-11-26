import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  DocumentReadError,
  EDocumentReadErrorCode,
  type TextFileReader,
} from '@ts-code-agent/core';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;

/** 有界读取普通文本文件，并在所有退出路径关闭句柄。 */
export const readTextFile: TextFileReader = async (target, options) => {
  const { maxBytes = DEFAULT_MAX_BYTES, signal } = options;
  checkCancellation(signal);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_READ_BYTES
  ) {
    throw new RangeError(`读取上限必须为 1 到 ${MAX_READ_BYTES} 之间的整数。`);
  }
  // 非阻塞打开后检查句柄，避免目标是 FIFO 时挂起。
  const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    checkCancellation(signal);
    if (!(await handle.stat()).isFile()) {
      throw new DocumentReadError(
        EDocumentReadErrorCode.INVALID_PATH,
        '导入目标必须是普通文件。',
      );
    }

    // 多读一个字节区分恰好达到上限与超限，超限时不交付截断正文。
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      checkCancellation(signal);
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
    }
    checkCancellation(signal);
    if (size > maxBytes) {
      throw new DocumentReadError(
        EDocumentReadErrorCode.FILE_TOO_LARGE,
        `文档超过 ${maxBytes} 字节。`,
      );
    }

    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) {
      throw new DocumentReadError(
        EDocumentReadErrorCode.INVALID_ENCODING,
        '文档包含 NUL 字节。',
      );
    }

    try {
      // 保留 BOM 和原始换行，由 Core 统一规范化一次，避免重复移除 BOM。
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch (cause) {
      throw new DocumentReadError(
        EDocumentReadErrorCode.INVALID_ENCODING,
        '文档必须使用 UTF-8 编码。',
        { cause },
      );
    }
  } finally {
    await handle.close();
  }
};

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DocumentReadError(
      EDocumentReadErrorCode.CANCELLED,
      '文档导入已取消。',
      {
        cause: signal.reason,
      },
    );
  }
}
