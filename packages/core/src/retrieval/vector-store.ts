export interface RetrievalFilter {
  readonly sourcePath?: string;
  readonly documentId?: string;
}

export interface VectorChunk {
  readonly chunkId: string;
  readonly ordinal: number;
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly headingPath: readonly string[];
  readonly embedding: readonly number[];
}

export interface IndexedDocument {
  readonly corpusId: string;
  readonly documentId: string;
  readonly contentHash: string;
  readonly sourcePath: string;
  /** 实际生成向量的模型标识，查询必须使用同一标识。 */
  readonly model: string;
  readonly dimensions: number;
  readonly chunks: readonly VectorChunk[];
}

export interface VectorSearchRequest {
  readonly filter?: RetrievalFilter;
  readonly corpusId: string;
  readonly model: string;
  readonly embedding: readonly number[];
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface VectorSearchHit {
  readonly documentId: string;
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly chunk: Omit<VectorChunk, 'embedding'>;
  readonly distance: number;
}

export interface VectorStore {
  /** 原子替换文档全部片段；空集合会清除旧片段。 */
  replaceDocument(
    document: IndexedDocument,
    signal?: AbortSignal,
  ): Promise<void>;
  search(request: VectorSearchRequest): Promise<readonly VectorSearchHit[]>;
}
