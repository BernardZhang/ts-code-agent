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
