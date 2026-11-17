import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { EAgentEventType } from '@ts-code-agent/core';
import { FileTraceSink } from './file-trace-sink.js';
import { ETraceSinkError } from './write-fully.js';
import { BatchTraceWriter } from './batch-writer.js';
import { ETraceFileRecordType, ETraceWriteStatus } from './writer-types.js';

it('排他创建、完整写入、幂等关闭，关闭后拒绝写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trace-sink-'));
  const path = join(dir, 'run.jsonl');
  const sink = await FileTraceSink.open(path);
  try {
    await sink.write(new TextEncoder().encode('第一行\n'));
    await expect(FileTraceSink.open(path)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await sink.write(new TextEncoder().encode('第二行\n'));
    const closing = sink.close();
    expect(sink.close()).toBe(closing);
    await expect(sink.write(new Uint8Array())).rejects.toMatchObject({
      code: ETraceSinkError.NOT_WRITABLE,
    });
    await closing;
    expect(await readFile(path, 'utf8')).toBe('第一行\n第二行\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await sink.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it('与Writer集成按序写入多批记录及footer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trace-writer-'));
  const path = join(dir, 'run.jsonl');
  const writer = new BatchTraceWriter(await FileTraceSink.open(path), {
    batchBytes: 1,
  });
  try {
    for (let sequence = 1; sequence <= 3; sequence++) {
      writer.enqueue({
        schemaVersion: 1,
        sequence,
        runId: 'run',
        elapsedMs: sequence,
        type: EAgentEventType.TEXT_DELTA,
        step: 1,
      });
    }
    expect((await writer.close()).status).toBe(ETraceWriteStatus.CLOSED);
    const lines: unknown[] = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toMatchObject([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
      { type: ETraceFileRecordType.FOOTER, written: 3 },
    ]);
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
