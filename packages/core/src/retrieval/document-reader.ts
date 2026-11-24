export enum EDocumentReadErrorCode {
  INVALID_PATH = 'INVALID_PATH',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',
  INVALID_ENCODING = 'INVALID_ENCODING',
  CANCELLED = 'CANCELLED',
}

export class DocumentReadError extends Error {
  constructor(
    readonly code: EDocumentReadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DocumentReadError';
  }
}

export interface TextFileReadOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

/** 读取实现由装配层提供，返回严格解码的 UTF-8 正文，BOM 与换行由 Core 导入层统一处理。 */
export type TextFileReader = (
  filePath: string,
  options: TextFileReadOptions,
) => Promise<string>;
