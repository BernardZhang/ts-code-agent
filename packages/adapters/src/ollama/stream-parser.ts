import { ModelError } from '@ts-code-agent/core';

// HTTP chunks can split both UTF-8 characters and JSON lines.
export async function* parseNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  const decode = (bytes?: Uint8Array, stream = false) => {
    try {
      return decoder.decode(bytes, { stream });
    } catch (cause) {
      throw new ModelError('protocol', '响应包含无效 UTF-8。', { cause });
    }
  };
  const parse = (line: string): unknown => {
    try {
      return JSON.parse(line);
    } catch (cause) {
      throw new ModelError('protocol', '响应流包含无效 JSON 行。', { cause });
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done ? decode() : decode(value, true);
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line) yield parse(line);
      }
      if (pending.length > 4 * 1024 * 1024) {
        throw new ModelError('protocol', '响应行超过 4 MiB 限制。');
      }
      if (done) break;
    }
    if (pending.trim()) yield parse(pending);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
