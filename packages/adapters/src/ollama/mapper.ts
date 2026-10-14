import { ModelError, type ModelUsage } from '@ts-code-agent/core';
import { z } from 'zod';

const responseSchema = z.object({
  done: z.boolean(),
  message: z.object({ role: z.literal('assistant'), content: z.string() }),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
});

export function mapResponse(raw: unknown) {
  const serviceError = z.object({ error: z.string() }).safeParse(raw);
  if (serviceError.success) {
    throw new ModelError('protocol', `Ollama: ${serviceError.data.error}`);
  }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ModelError('protocol', 'Ollama 响应格式不合法。', {
      cause: parsed.error,
    });
  }
  const data = parsed.data;
  const usage: ModelUsage = {};
  if (data.prompt_eval_count !== undefined)
    usage.inputTokens = data.prompt_eval_count;
  if (data.eval_count !== undefined) usage.outputTokens = data.eval_count;
  return {
    text: data.message.content,
    done: data.done,
    usage,
    finishReason: data.done_reason,
  };
}
