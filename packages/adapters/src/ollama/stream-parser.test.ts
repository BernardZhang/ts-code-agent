import { describe, expect, it } from 'vitest';
import { parseNdjson } from './stream-parser.js';

function chunks(bytes: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(byte);
      controller.close();
    },
  });
}

describe('NDJSON parser', () => {
  it.each([
    'single chunk',
    'split chunks',
    'no newline',
    'multibyte',
    'whitespace',
  ])('rejects oversized records before parsing: %s', async (scenario) => {
    const limit = 4 * 1024 * 1024;
    const line =
      scenario === 'multibyte'
        ? JSON.stringify('你'.repeat(Math.ceil(limit / 3)))
        : scenario === 'whitespace'
          ? ' '.repeat(limit) + '{}'
          : JSON.stringify('x'.repeat(limit));
    const bytes = new TextEncoder().encode(
      line + (scenario === 'no newline' ? '' : '\n'),
    );
    const parts =
      scenario === 'split chunks'
        ? [bytes.slice(0, 100), bytes.slice(100)]
        : [bytes];
    const body = chunks(parts);
    const consume = async () => {
      for await (const value of parseNdjson(body)) void value;
    };
    await expect(consume()).rejects.toMatchObject({
      code: 'protocol',
      message: '响应行超过 4 MiB 限制。',
    });
    expect(body.locked).toBe(false);
  });

  it('accepts individual records at the limit even when their combined chunk exceeds it', async () => {
    const value = 'x'.repeat(4 * 1024 * 1024 - 2);
    const line = JSON.stringify(value);
    const result = [];
    for await (const item of parseNdjson(
      chunks([new TextEncoder().encode(line + '\n' + line)]),
    ))
      result.push(item);
    expect(result).toEqual([value, value]);
  });

  it('handles split UTF-8, CRLF, blank lines and a final line without newline', async () => {
    const bytes = new TextEncoder().encode(
      '\r\n{"text":"你好"}\r\n{"done":true}',
    );
    const result = [];
    for await (const value of parseNdjson(
      chunks(Array.from(bytes, (byte) => Uint8Array.of(byte))),
    ))
      result.push(value);
    expect(result).toEqual([{ text: '你好' }, { done: true }]);
  });

  it('rejects malformed JSON and invalid UTF-8', async () => {
    for (const bytes of [
      new TextEncoder().encode('{broken}\n'),
      Uint8Array.of(255),
    ]) {
      const consume = async () => {
        for await (const value of parseNdjson(chunks([bytes]))) void value;
      };
      await expect(consume()).rejects.toMatchObject({ code: 'protocol' });
    }
  });

  it('cancels its reader when the consumer stops early', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"x":1}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const value of parseNdjson(body)) {
      void value;
      break;
    }
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it('rejects incomplete UTF-8 at end of stream', async () => {
    const consume = async () => {
      for await (const value of parseNdjson(chunks([Uint8Array.of(0xe4)])))
        void value;
    };

    await expect(consume()).rejects.toMatchObject({
      code: 'protocol',
      message: '响应包含无效 UTF-8。',
    });
  });
});
