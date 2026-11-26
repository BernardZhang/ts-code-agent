/** 一次批量向量化请求，文档片段和查询文本共用此契约。 */
export interface EmbeddingRequest {
  readonly model: string;
  readonly texts: readonly string[];
  readonly signal?: AbortSignal;
}

export interface EmbeddingResult {
  /** 实际生成向量的模型标识，用于记录和检查索引的模型来源。 */
  readonly model: string;
  /**
   * 与请求 texts 按位置一一对应，数量必须相同。
   * 同次结果的维度必须一致，所有分量必须为有限数值。
   * 具体 Provider 在外部响应边界完成校验，失败时拒绝整个请求。
   */
  readonly embeddings: readonly (readonly number[])[];
}

export interface EmbeddingProvider {
  /** 生成整批向量，支持取消，失败时通过 Promise rejection 报告。 */
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}
