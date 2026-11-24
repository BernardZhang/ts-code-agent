import { z } from 'zod';

const embeddingConfigSchema = z.object({
  baseUrl: z.url().refine((url) => {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }),
  model: z.string().trim().min(1),
  dimensions: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  timeoutMs: z.coerce.number().int().min(1).max(2_147_483_647),
});

export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;
export interface EmbeddingConfigOptions {
  baseUrl?: string;
  model?: string;
  dimensions?: string;
  timeoutMs?: string;
}

/** 模型和维度必须显式配置，避免默认值与本地模型输出不一致。 */
export function readEmbeddingConfig(
  options: EmbeddingConfigOptions,
  env = process.env,
): EmbeddingConfig {
  return embeddingConfigSchema.parse({
    baseUrl: options.baseUrl ?? env.AGENT_BASE_URL ?? 'http://127.0.0.1:11434',
    model: options.model ?? env.AGENT_EMBEDDING_MODEL,
    dimensions: options.dimensions ?? env.AGENT_EMBEDDING_DIMENSIONS,
    timeoutMs: options.timeoutMs ?? env.AGENT_TIMEOUT_MS ?? 120_000,
  });
}
