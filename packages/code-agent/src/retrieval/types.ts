import {
  EDocumentReadErrorCode,
  type ParsedDocument,
} from '@ts-code-agent/core';

export const EIngestErrorCode = {
  ...EDocumentReadErrorCode,
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
} as const;

export interface IngestDocumentOptions {
  readonly rootPath: string;
  readonly sourcePath: string;
  readonly corpusId: string;
  readonly maxBytes?: number;
  readonly maxChunkCodePoints?: number;
  readonly signal?: AbortSignal;
}

export type IngestDocumentResult = ParsedDocument;
