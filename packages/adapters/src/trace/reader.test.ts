import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  EAgentEventType,
  EAgentStatus,
  EAgentRunFailure,
} from '@ts-code-agent/core';
import { ETraceFileRecordType, ETraceWriteStatus } from './writer-types.js';
import {
  readTrace,
  ETraceReadItemType,
  ETraceReadDiagnostic,
  MAX_TRACE_LINE_BYTES,
} from './reader.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const header = {
  type: ETraceFileRecordType.HEADER,
  schemaVersion: 1,
  runId: 'run',
  createdAt: '2026-11-10T00:00:00.000Z',
};
const start = {
  schemaVersion: 1,
  runId: 'run',
  type: EAgentEventType.RUN_STARTED,
  sequence: 1,
  elapsedMs: 0,
};
const finish = {
  ...start,
  type: EAgentEventType.RUN_FINISHED,
  sequence: 2,
  elapsedMs: 1,
  steps: 0,
  status: EAgentStatus.COMPLETE,
};
const footer = {
  ...header,
  type: ETraceFileRecordType.FOOTER,
  status: ETraceWriteStatus.CLOSED,
  accepted: 2,
  written: 2,
  dropped: 0,
  oversized: 0,
  writeFailed: 0,
  lastReceivedSequence: 2,
};
async function fixture(content: string | Uint8Array) {
  const dir = await mkdtemp(join(tmpdir(), 'trace-reader-'));
  dirs.push(dir);
  const path = join(dir, 'trace.jsonl');
  await writeFile(path, content);
  return path;
}
const jsonl = (...records: unknown[]) =>
  records.map((r) => JSON.stringify(r)).join('\n') + '\n';
async function collect(content: string | Uint8Array) {
  const items = [];
  for await (const item of readTrace(await fixture(content))) {
    items.push(item);
  }
  return items;
}
it('reads complete trace and strips private unknown fields recursively', async () => {
  const items = await collect(
    jsonl(
      { ...header, secret: 'private' },
      { ...start, text: 'private' },
      finish,
      { ...footer, secret: 'private' },
    ),
  );
  expect(items).toHaveLength(4);
  expect(items.every((i) => i.type === ETraceReadItemType.RECORD)).toBe(true);
  expect(JSON.stringify(items)).not.toContain('private');
});
it('preserves good records after corrupt middle and diagnoses gaps', async () => {
  const items = await collect(
    jsonl(header, start) +
      '{bad}\n' +
      jsonl({ ...finish, sequence: 3 }, { ...footer, lastReceivedSequence: 3 }),
  );
  expect(items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: ETraceReadDiagnostic.INVALID_JSON }),
      expect.objectContaining({ code: ETraceReadDiagnostic.SEQUENCE_GAP }),
    ]),
  );
  expect(
    items.filter((i) => i.type === ETraceReadItemType.RECORD),
  ).toHaveLength(4);
});
it('detects corrupt tail, truncation, and missing footer/terminal', async () => {
  const items = await collect(jsonl(header, start) + '{"broken"');
  for (const code of [
    ETraceReadDiagnostic.TRUNCATED,
    ETraceReadDiagnostic.MISSING_FOOTER,
    ETraceReadDiagnostic.MISSING_RUN_FINISHED,
  ]) {
    expect(items).toContainEqual(expect.objectContaining({ code }));
  }
});
it('bounds oversized lines and recovers', async () => {
  const items = await collect(
    jsonl(header, start) +
      'x'.repeat(MAX_TRACE_LINE_BYTES * 3) +
      '\n' +
      jsonl(finish, footer),
  );
  expect(items).toContainEqual(
    expect.objectContaining({ code: ETraceReadDiagnostic.LINE_TOO_LONG }),
  );
  expect(
    items.filter((i) => i.type === ETraceReadItemType.RECORD),
  ).toHaveLength(4);
});
it('rejects invalid version, types, numbers and UTF8 without leaking input', async () => {
  const content = jsonl(
    header,
    { ...start, schemaVersion: 99 },
    { ...start, sequence: -1 },
    { ...start, type: 'private' },
    { ...finish, elapsedMs: Number.POSITIVE_INFINITY },
  );
  const items = await collect(
    Buffer.concat([
      Buffer.from(content),
      Buffer.from([0xff, 10]),
      Buffer.from(jsonl(footer)),
    ]),
  );
  expect(items).toContainEqual(
    expect.objectContaining({ code: ETraceReadDiagnostic.UNKNOWN_VERSION }),
  );
  expect(items).toContainEqual(
    expect.objectContaining({ code: ETraceReadDiagnostic.INVALID_RECORD }),
  );
  expect(items).toContainEqual(
    expect.objectContaining({ code: ETraceReadDiagnostic.INVALID_UTF8 }),
  );
  expect(JSON.stringify(items)).not.toContain('private');
});
it('aborts before opening and during iteration', async () => {
  const path = await fixture(jsonl(header, start, finish, footer));
  const control = new AbortController();
  const iterator = readTrace(path, control.signal)[Symbol.asyncIterator]();
  await iterator.next();
  control.abort();
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  await expect(
    readTrace(path, control.signal)[Symbol.asyncIterator]().next(),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

it('reports misplaced headers, reversed sequences, foreign run and post-footer data', async () => {
  const items = await collect(
    jsonl(
      start,
      header,
      start,
      { ...finish, runId: 'other' },
      finish,
      footer,
      start,
    ),
  );
  for (const code of [
    ETraceReadDiagnostic.OUT_OF_ORDER,
    ETraceReadDiagnostic.RUN_ID_MISMATCH,
    ETraceReadDiagnostic.AFTER_FOOTER,
    ETraceReadDiagnostic.AFTER_TERMINAL,
  ]) {
    expect(items).toContainEqual(expect.objectContaining({ code }));
  }
});
it('accepts failed terminal as complete lifecycle and detects missing header', async () => {
  const items = await collect(
    jsonl(
      header,
      start,
      { ...finish, status: EAgentRunFailure.FAILED },
      footer,
    ),
  );
  expect(items.filter((i) => i.type === ETraceReadItemType.DIAGNOSTIC)).toEqual(
    [],
  );
  const missing = await collect(jsonl(start, finish, footer));
  expect(missing).toContainEqual(
    expect.objectContaining({ code: ETraceReadDiagnostic.MISSING_HEADER }),
  );
});
it('strips nested usage extras and rejects invalid tool outcomes', async () => {
  const model = {
    ...start,
    type: EAgentEventType.MODEL_FINISHED,
    sequence: 2,
    step: 1,
    usage: { inputTokens: 3, private: 'secret' },
  };
  const invalid = {
    ...start,
    type: EAgentEventType.TOOL_CALL_FINISHED,
    step: 1,
    toolCallId: 'call',
    toolName: 'tool',
    success: false,
    errorCode: 'secret',
  };
  const items = await collect(
    jsonl(
      header,
      start,
      model,
      invalid,
      { ...finish, sequence: 3 },
      { ...footer, accepted: 3, written: 3, lastReceivedSequence: 3 },
    ),
  );
  expect(items).toContainEqual(
    expect.objectContaining({ code: ETraceReadDiagnostic.INVALID_RECORD }),
  );
  expect(JSON.stringify(items)).not.toContain('secret');
});
it('diagnoses footer count mismatch and lost trailing events', async () => {
  const items = await collect(
    jsonl(header, start, finish, {
      ...footer,
      written: 1,
      dropped: 2,
      lastReceivedSequence: 4,
    }),
  );
  for (const code of [
    ETraceReadDiagnostic.FOOTER_MISMATCH,
    ETraceReadDiagnostic.SEQUENCE_GAP,
    ETraceReadDiagnostic.INCOMPLETE_WRITE,
  ]) {
    expect(items).toContainEqual(expect.objectContaining({ code }));
  }
});
