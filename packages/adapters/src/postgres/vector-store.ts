import { Client } from 'pg';
import { z } from 'zod';
import type {
  IndexedDocument,
  KeywordSearchRequest,
  KeywordSearchHit,
  RetrievalFilter,
  HybridSearchStore,
  VectorSearchHit,
  VectorSearchRequest,
  VectorStore,
} from '@ts-code-agent/core';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DIMENSIONS = 16_000;
const VECTOR_FLOAT_MAX = 3.4028234663852886e38;

const metadataSchema = z.object({
  chunkId: z.string(),
  ordinal: z.number().int().nonnegative(),
  text: z.string(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  headingPath: z.array(z.string()),
});
const hitSchema = z.object({
  document_id: z.string(),
  source_path: z.string(),
  content_hash: z.string(),
  metadata: metadataSchema,
  distance: z.number(),
});

const keywordHitSchema = hitSchema.omit({ distance: true }).extend({
  matched_terms: z.number().int().positive(),
});

export interface PostgresVectorStoreOptions {
  connectionString: string;
  dimensions: number;
  timeoutMs?: number;
}

/** 小型学习语料采用精确余弦查询，每次操作使用独立且有超时的连接。 */
export class PostgresVectorStore implements VectorStore, HybridSearchStore {
  private readonly timeoutMs: number;

  constructor(private readonly options: PostgresVectorStoreOptions) {
    const url = new URL(options.connectionString);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new TypeError('数据库地址必须使用 PostgreSQL 协议。');
    }
    if (
      !Number.isSafeInteger(options.dimensions) ||
      options.dimensions < 1 ||
      options.dimensions > MAX_DIMENSIONS
    ) {
      throw new RangeError('向量维度必须为 1 到 16000 的整数。');
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 2_147_483_647
    ) {
      throw new RangeError('数据库超时必须为合法正整数毫秒数。');
    }
  }

  /** 显式初始化扩展和专用表，DDL 在单一事务内串行执行。 */
  async initialize(signal?: AbortSignal): Promise<void> {
    await this.withClient(signal, async (client) => {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('ts-code-agent-rag-schema-v1', 0))",
      );
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`CREATE TABLE IF NOT EXISTS agent_rag_documents (
        corpus_id text NOT NULL,
        document_id text NOT NULL,
        content_hash text NOT NULL,
        source_path text NOT NULL,
        model text NOT NULL,
        dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
        PRIMARY KEY (corpus_id, document_id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS agent_rag_chunks (
        corpus_id text NOT NULL,
        document_id text NOT NULL,
        chunk_id text NOT NULL,
        ordinal integer NOT NULL CHECK (ordinal >= 0),
        dimensions integer NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
        embedding vector NOT NULL CHECK (vector_dims(embedding) = dimensions),
        metadata jsonb NOT NULL,
        PRIMARY KEY (corpus_id, document_id, chunk_id),
        UNIQUE (corpus_id, document_id, ordinal),
        FOREIGN KEY (corpus_id, document_id)
          REFERENCES agent_rag_documents ON DELETE CASCADE
      )`);
      signal?.throwIfAborted();
      await client.query('COMMIT');
    });
  }

  async replaceDocument(
    document: IndexedDocument,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (
      !document.corpusId.trim() ||
      !document.documentId.trim() ||
      !document.model.trim() ||
      document.dimensions !== this.options.dimensions
    ) {
      throw new TypeError('文档标识、模型或维度不合法。');
    }
    const ids = new Set<string>();
    document.chunks.forEach((chunk, index) => {
      metadataSchema.parse(chunk);
      if (
        chunk.ordinal !== index ||
        ids.has(chunk.chunkId) ||
        chunk.endOffset < chunk.startOffset ||
        chunk.endLine < chunk.startLine
      ) {
        throw new TypeError('片段序号、ID 或来源范围不合法。');
      }
      ids.add(chunk.chunkId);
      this.validateVector(chunk.embedding);
    });

    await this.withClient(signal, async (client) => {
      await client.query('BEGIN');
      // 同一逻辑文档的并发导入按提交顺序替换，避免片段交错。
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([document.corpusId, document.documentId])],
      );
      await client.query(
        `INSERT INTO agent_rag_documents
        (corpus_id, document_id, content_hash, source_path, model, dimensions)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (corpus_id, document_id) DO UPDATE SET
          content_hash = EXCLUDED.content_hash, source_path = EXCLUDED.source_path,
          model = EXCLUDED.model, dimensions = EXCLUDED.dimensions`,
        [
          document.corpusId,
          document.documentId,
          document.contentHash,
          document.sourcePath,
          document.model,
          document.dimensions,
        ],
      );
      await client.query(
        'DELETE FROM agent_rag_chunks WHERE corpus_id=$1 AND document_id=$2',
        [document.corpusId, document.documentId],
      );
      for (const chunk of document.chunks) {
        signal?.throwIfAborted();
        const { embedding, ...metadata } = chunk;
        await client.query(
          `INSERT INTO agent_rag_chunks
          (corpus_id, document_id, chunk_id, ordinal, dimensions, embedding, metadata)
          VALUES ($1,$2,$3,$4,$5,$6::vector,$7::jsonb)`,
          [
            document.corpusId,
            document.documentId,
            chunk.chunkId,
            chunk.ordinal,
            document.dimensions,
            JSON.stringify(embedding),
            JSON.stringify(metadata),
          ],
        );
      }
      signal?.throwIfAborted();
      await client.query('COMMIT');
    });
  }

  async search(
    request: VectorSearchRequest,
  ): Promise<readonly VectorSearchHit[]> {
    request.signal?.throwIfAborted();
    this.validateVector(request.embedding);
    if (
      !request.corpusId.trim() ||
      !request.model.trim() ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100
    ) {
      throw new RangeError('查询资料集、模型及 limit（1 到 100）不合法。');
    }
    return this.withClient(request.signal, async (client) => {
      const parameters: unknown[] = [
        JSON.stringify(request.embedding),
        request.corpusId,
        request.model,
        this.options.dimensions,
        request.limit,
      ];
      const filter = this.searchFilter(request.filter, parameters);
      const result = await client.query(
        `SELECT d.document_id, d.source_path,
        d.content_hash, c.metadata, c.embedding <=> $1::vector AS distance
        FROM agent_rag_chunks c JOIN agent_rag_documents d
          ON c.corpus_id=d.corpus_id AND c.document_id=d.document_id
        WHERE d.corpus_id=$2 AND d.model=$3 AND d.dimensions=$4
        ${filter}
        ORDER BY distance, d.document_id, c.chunk_id LIMIT $5`,
        parameters,
      );
      request.signal?.throwIfAborted();
      return result.rows.map((row: unknown) => {
        const hit = hitSchema.parse(row);
        return {
          documentId: hit.document_id,
          sourcePath: hit.source_path,
          contentHash: hit.content_hash,
          chunk: hit.metadata,
          distance: hit.distance,
        };
      });
    });
  }

  /** 大小写敏感的字面子串匹配，按命中的不同词项数降序排列。 */
  async searchKeywords(
    request: KeywordSearchRequest,
  ): Promise<readonly KeywordSearchHit[]> {
    request.signal?.throwIfAborted();
    const terms = [...new Set(request.terms.map((term) => term.trim()))];
    if (
      !request.corpusId.trim() ||
      !request.model.trim() ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100 ||
      !terms.length ||
      terms.some((term) => !term || term.includes('\0'))
    ) {
      throw new TypeError('关键词、资料集、模型或检索数量不合法。');
    }
    return this.withClient(request.signal, async (client) => {
      const parameters: unknown[] = [
        terms,
        request.corpusId,
        request.model,
        this.options.dimensions,
        request.limit,
      ];
      const filter = this.searchFilter(request.filter, parameters);
      // strpos 使用参数的原始字面量，% 和 _ 不具有 LIKE 通配符含义。
      const result = await client.query(
        `SELECT d.document_id, d.source_path,
        d.content_hash, c.metadata, matches.matched_terms
        FROM agent_rag_chunks c JOIN agent_rag_documents d
          ON c.corpus_id=d.corpus_id AND c.document_id=d.document_id
        CROSS JOIN LATERAL (
          SELECT count(*)::integer AS matched_terms FROM unnest($1::text[]) AS terms(term)
          WHERE strpos(c.metadata->>'text', term) > 0
        ) matches
        WHERE d.corpus_id=$2 AND d.model=$3 AND d.dimensions=$4
          AND matches.matched_terms > 0 ${filter}
        ORDER BY matches.matched_terms DESC, d.document_id, c.chunk_id LIMIT $5`,
        parameters,
      );
      request.signal?.throwIfAborted();
      return result.rows.map((row: unknown) => {
        const hit = keywordHitSchema.parse(row);
        return {
          documentId: hit.document_id,
          sourcePath: hit.source_path,
          contentHash: hit.content_hash,
          chunk: hit.metadata,
          matchedTerms: hit.matched_terms,
        };
      });
    });
  }

  private searchFilter(
    filter: RetrievalFilter | undefined,
    parameters: unknown[],
  ): string {
    const clauses: string[] = [];
    if (filter?.sourcePath !== undefined) {
      if (!filter.sourcePath.trim()) {
        throw new TypeError('来源路径过滤不能为空。');
      }
      parameters.push(filter.sourcePath);
      clauses.push(`AND d.source_path=$${parameters.length}`);
    }
    if (filter?.documentId !== undefined) {
      if (!filter.documentId.trim()) {
        throw new TypeError('文档 ID 过滤不能为空。');
      }
      parameters.push(filter.documentId);
      clauses.push(`AND d.document_id=$${parameters.length}`);
    }
    return clauses.join(' ');
  }

  private validateVector(vector: readonly number[]): void {
    if (
      vector.length !== this.options.dimensions ||
      vector.some(
        (value) =>
          !Number.isFinite(value) || Math.abs(value) > VECTOR_FLOAT_MAX,
      ) ||
      !vector.some((value) => Math.fround(value) !== 0)
    ) {
      throw new TypeError(
        '向量必须维度匹配、分量为有限 float32，且不能为零向量。',
      );
    }
  }

  private async withClient<T>(
    signal: AbortSignal | undefined,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const client = new Client({
      connectionString: this.options.connectionString,
      connectionTimeoutMillis: this.timeoutMs,
      statement_timeout: this.timeoutMs,
      query_timeout: this.timeoutMs,
    });
    // 关闭本次专属连接会终止在途查询，未提交事务由服务器回滚。
    const cancel = () => {
      void client.end().catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      await client.connect();
      signal?.throwIfAborted();
      return await operation(client);
    } catch (cause) {
      signal?.throwIfAborted();
      throw new Error('向量数据库操作失败，请检查连接、扩展、权限及表结构。', {
        cause,
      });
    } finally {
      signal?.removeEventListener('abort', cancel);
      await client.end();
    }
  }
}
