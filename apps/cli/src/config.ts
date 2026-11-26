import { z } from 'zod';

const booleanOption = z.preprocess((value) => {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return value;
}, z.boolean());

const configSchema = z.object({
  baseUrl: z
    .url()
    .refine((url) => ['http:', 'https:'].includes(new URL(url).protocol)),
  model: z.string().trim().min(1),
  contextLength: z.coerce.number().int().min(256).max(1_048_576),
  timeoutMs: z.coerce.number().int().min(1).max(2_147_483_647),
  think: booleanOption,
});

export type Config = z.infer<typeof configSchema>;
export interface ConfigOptions {
  baseUrl?: string;
  model?: string;
  contextLength?: string;
  timeoutMs?: string;
  think?: string;
}

export function readConfig(options: ConfigOptions, env = process.env): Config {
  return configSchema.parse({
    baseUrl: options.baseUrl ?? env.AGENT_BASE_URL,
    model: options.model ?? env.AGENT_MODEL,
    contextLength: options.contextLength ?? env.AGENT_CONTEXT_LENGTH,
    timeoutMs: options.timeoutMs ?? env.AGENT_TIMEOUT_MS,
    think: options.think ?? env.AGENT_THINK,
  });
}
