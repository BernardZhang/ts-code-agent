export enum EDocumentFormat {
  MARKDOWN = 'markdown',
  TEXT = 'text',
}

export interface Document {
  readonly corpusId: string;
  readonly sourcePath: string;
  /** 同一资料集下，同一路径更新正文时沿用此 ID。 */
  readonly documentId: string;
  /** 基于规范化全文的版本标识。 */
  readonly contentHash: string;
  readonly format: EDocumentFormat;
  readonly text: string;
}

/** 偏移是规范化全文中的 UTF-16 半开区间，可直接用于 String.slice。 */
export interface DocumentSection {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly headingPath: readonly string[];
}

export interface Chunk extends DocumentSection {
  readonly chunkId: string;
  readonly documentId: string;
  readonly ordinal: number;
  readonly text: string;
  /** 行号从 1 开始且包含两端，末行取片段最后一个字符所在行。 */
  readonly startLine: number;
  readonly endLine: number;
}

/** 已完成解析与分片的文档，供通用索引编排消费。 */
export interface ParsedDocument {
  readonly document: Document;
  readonly chunks: readonly Chunk[];
}
