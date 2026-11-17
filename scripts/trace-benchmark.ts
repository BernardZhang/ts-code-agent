import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { EAgentEventType, TraceCollector } from '@ts-code-agent/core';
import {
  BatchTraceWriter,
  ETraceAdmission,
  FileTraceSink,
  type TraceSink,
} from '@ts-code-agent/adapters';
const EVENT_COUNT = 100_000;
const MAX_PENDING_BYTES = 1024 * 1024;
const directory = await mkdtemp(join(tmpdir(), 'trace-benchmark-'));
try {
  for (const delayMs of [0, 10]) {
    const file = await FileTraceSink.open(
      join(directory, `trace-${delayMs}.jsonl`),
    );
    let writeCalls = 0;
    let pendingBytes = 0;
    let maxPendingBytesObserved = 0;
    const sink: TraceSink = {
      async write(bytes) {
        writeCalls++;
        if (delayMs > 0) {
          await setTimeout(delayMs);
        }
        await file.write(bytes);
        pendingBytes = Math.max(0, pendingBytes - bytes.byteLength);
      },
      close: () => file.close(),
    };
    const writer = new BatchTraceWriter(sink, {
      maxPendingBytes: MAX_PENDING_BYTES,
    });
    const collector = new TraceCollector('benchmark');
    const started = performance.now();
    for (let index = 0; index < EVENT_COUNT; index++) {
      const record = collector.record({
        type: EAgentEventType.TEXT_DELTA,
        runId: 'benchmark',
        elapsedMs: index,
        step: 1,
        text: 'never persisted',
      });
      if (record && writer.enqueue(record) === ETraceAdmission.ACCEPTED) {
        pendingBytes += Buffer.byteLength(JSON.stringify(record) + '\n');
        maxPendingBytesObserved = Math.max(
          maxPendingBytesObserved,
          pendingBytes,
        );
      }
      if (index % 1000 === 0) {
        await setTimeout(0);
      }
    }
    const enqueueDurationMs = performance.now() - started;
    const flushStarted = performance.now();
    const flushed = await writer.flush();
    const flushLatencyMs = performance.now() - flushStarted;
    const closed = await writer.close();
    console.log(
      JSON.stringify({
        node: process.version,
        eventCount: EVENT_COUNT,
        sinkDelayMs: delayMs,
        enqueueDurationMs,
        durationMs: performance.now() - started,
        flushLatencyMs,
        writeCalls,
        maxPendingBytesObserved,
        maxPendingBytesLimit: MAX_PENDING_BYTES,
        flushStatus: flushed.status,
        ...closed,
      }),
    );
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
