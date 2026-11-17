import { expect, it, vi } from 'vitest';
import {
  EAgentEventType,
  EAgentStatus,
  type TraceRecord,
} from '@ts-code-agent/core';
import { BatchTraceWriter } from './batch-writer.js';
import { ETraceAdmission, ETraceWriteStatus } from './writer-types.js';

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function record(
  sequence: number,
): Extract<TraceRecord, { type: EAgentEventType.TEXT_DELTA }> {
  return {
    schemaVersion: 1,
    sequence,
    runId: 'test-run',
    elapsedMs: sequence,
    type: EAgentEventType.TEXT_DELTA,
    step: 1,
  };
}
function fixture(blocked = false) {
  const release = gate();
  const lines: string[] = [];
  const write = vi.fn(async (bytes: Uint8Array) => {
    if (blocked) {
      await release.promise;
    }
    lines.push(new TextDecoder().decode(bytes));
  });
  const close = vi.fn(async () => {});
  return { sink: { write, close }, write, close, release, lines };
}

it('100ms触发批量写入，close写页脚且只关闭一次', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const writer = new BatchTraceWriter(f.sink);
  try {
    expect(writer.enqueue(record(1))).toBe(ETraceAdmission.ACCEPTED);
    writer.enqueue(record(2));
    expect(f.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(99);
    expect(f.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.write).toHaveBeenCalledTimes(1);
    const first = writer.close();
    expect(writer.close()).toBe(first);
    expect((await first).status).toBe(ETraceWriteStatus.CLOSED);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.lines[0]?.split('\n').filter(Boolean)).toHaveLength(2);
    expect(JSON.parse(f.lines[1] ?? '').written).toBe(2);
    expect(writer.enqueue(record(3))).toBe(ETraceAdmission.CLOSED);
  } finally {
    await writer.close();
    vi.useRealTimers();
  }
});

it('在途批次计入预算，满队列拒绝，首次终态用保留槽且保持顺序', async () => {
  const f = fixture(true);
  const size = new TextEncoder().encode(
    JSON.stringify(record(1)) + '\n',
  ).length;
  const writer = new BatchTraceWriter(f.sink, {
    batchBytes: size,
    maxPendingBytes: size * 2,
  });
  try {
    writer.enqueue(record(1));
    writer.enqueue(record(2));
    expect(writer.enqueue(record(3))).toBe(ETraceAdmission.FULL);
    const terminal: TraceRecord = {
      ...record(4),
      type: EAgentEventType.RUN_FINISHED,
      steps: 1,
      status: EAgentStatus.COMPLETE,
    };
    expect(writer.enqueue(terminal)).toBe(ETraceAdmission.ACCEPTED);
    expect(writer.enqueue({ ...terminal, sequence: 5 })).toBe(
      ETraceAdmission.FULL,
    );
    expect(f.write).toHaveBeenCalledTimes(1);
    const pending = writer.close();
    f.release.resolve();
    const report = await pending;
    expect(report).toMatchObject({
      accepted: 3,
      written: 3,
      dropped: 2,
      firstDroppedSequence: 3,
      lastDroppedSequence: 5,
    });
    const events = f.lines.slice(0, -1).flatMap((line) =>
      line
        .trim()
        .split('\n')
        .map((value) => JSON.parse(value)),
    );
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 4]);
  } finally {
    f.release.resolve();
    await writer.close();
  }
});

it('flush屏障不被后续事件阻塞，同步入队已复制编码内容', async () => {
  const first = gate();
  const second = gate();
  const write = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockResolvedValue(undefined);
  const close = vi.fn(async () => {});
  const writer = new BatchTraceWriter({ write, close }, { batchBytes: 1 });
  const input = record(1);
  writer.enqueue(input);
  const flushed = writer.flush();
  input.runId = 'mutated';
  writer.enqueue(record(2));
  try {
    first.resolve();
    expect(await flushed).toMatchObject({
      accepted: 1,
      written: 1,
      status: ETraceWriteStatus.FLUSHED,
    });
    expect(new TextDecoder().decode(write.mock.calls[0]?.[0])).not.toContain(
      'mutated',
    );
    expect(close).not.toHaveBeenCalled();
  } finally {
    second.resolve();
    await writer.close();
  }
});

it('写入失败明确报告并拒绝后续事件，sink仍恰好关闭一次', async () => {
  const sink = {
    write: vi.fn(async () => {
      throw new Error('PRIVATE disk failure');
    }),
    close: vi.fn(async () => {}),
  };
  const writer = new BatchTraceWriter(sink);
  writer.enqueue(record(1));
  const report = await writer.close();
  expect(report).toMatchObject({
    status: ETraceWriteStatus.FAILED,
    written: 0,
    writeFailed: 1,
  });
  expect(writer.enqueue(record(2))).toBe(ETraceAdmission.FAILED);
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
  expect(sink.close).toHaveBeenCalledTimes(1);
});

it('close超时只结束等待，实际写入完成后settled仍能收敛', async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  const writer = new BatchTraceWriter(f.sink, { timeoutMs: 50 });
  writer.enqueue(record(1));
  const pending = writer.close();
  try {
    await vi.advanceTimersByTimeAsync(50);
    expect((await pending).status).toBe(ETraceWriteStatus.TIMED_OUT);
    expect(f.close).not.toHaveBeenCalled();
    f.release.resolve();
    expect((await writer.settled).status).toBe(ETraceWriteStatus.CLOSED);
    expect(f.close).toHaveBeenCalledTimes(1);
  } finally {
    f.release.resolve();
    await writer.settled;
    vi.useRealTimers();
  }
});

it('flush超时只清理自身等待项，不影响其他等待者和关闭收尾', async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  const writer = new BatchTraceWriter(f.sink, { timeoutMs: 50 });

  try {
    writer.enqueue(record(1));
    const first = writer.flush();

    await vi.advanceTimersByTimeAsync(25);
    const second = writer.flush();
    const closing = writer.close();

    // 两个 flush 等待项，以及 finish 内部的等待项。
    expect(Reflect.get(writer, 'barriers')).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(25);
    expect((await first).status).toBe(ETraceWriteStatus.TIMED_OUT);

    // 第一个 flush 已被移除，其他两个等待项仍然保留。
    expect(Reflect.get(writer, 'barriers')).toHaveLength(2);
    expect(f.lines).toHaveLength(0);
    expect(f.close).not.toHaveBeenCalled();

    f.release.resolve();

    expect(await second).toMatchObject({
      status: ETraceWriteStatus.FLUSHED,
      accepted: 1,
      written: 1,
    });
    expect((await closing).status).toBe(ETraceWriteStatus.CLOSED);
    expect(Reflect.get(writer, 'barriers')).toHaveLength(0);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.lines[0] ?? '')).toMatchObject({ sequence: 1 });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    f.release.resolve();
    await writer.close();
    await writer.settled;
    vi.useRealTimers();
  }
});

it('按UTF-8字节限制合法记录，超限拒绝并写入页脚计数', async () => {
  const f = fixture();
  const input: TraceRecord = {
    ...record(1),
    type: EAgentEventType.TOOL_CALL_READY,
    toolCallId: 'A',
    toolName: '查询',
    step: 1,
  };
  const byteLength = new TextEncoder().encode(
    JSON.stringify(input) + '\n',
  ).length;
  const writer = new BatchTraceWriter(f.sink, {
    maxRecordBytes: byteLength - 1,
  });
  expect(writer.enqueue(input)).toBe(ETraceAdmission.OVERSIZED);
  const report = await writer.close();
  expect(report).toMatchObject({
    accepted: 0,
    written: 0,
    dropped: 1,
    oversized: 1,
    lastReceivedSequence: 1,
  });
  expect(JSON.parse(f.lines[0] ?? '')).toMatchObject({
    dropped: 1,
    oversized: 1,
  });
});

it('多个flush共享同一写入过程，每个屏障确认自己的记录', async () => {
  const f = fixture(true);
  const writer = new BatchTraceWriter(f.sink);
  writer.enqueue(record(1));
  const first = writer.flush();
  const second = writer.flush();
  f.release.resolve();
  expect((await first).written).toBe(1);
  expect((await second).written).toBe(1);
  expect(f.write).toHaveBeenCalledTimes(1);
  await writer.close();
});

it('sink关闭异常不伪装成功，参数拒绝定时器溢出和非法容量', async () => {
  const f = fixture();
  for (const maxPendingBytes of [0, -1, Infinity, 1.5]) {
    expect(() => new BatchTraceWriter(f.sink, { maxPendingBytes })).toThrow(
      RangeError,
    );
  }
  expect(() => new BatchTraceWriter(f.sink, { intervalMs: 2 ** 31 })).toThrow(
    RangeError,
  );
  f.close.mockRejectedValueOnce(new Error('PRIVATE close failed'));
  const writer = new BatchTraceWriter(f.sink);
  writer.enqueue(record(1));
  const report = await writer.close();
  expect(report).toMatchObject({
    status: ETraceWriteStatus.FAILED,
    accepted: 1,
    written: 1,
  });
  expect(JSON.stringify(report)).not.toContain('PRIVATE');
});

it('容量预留拒绝普通记录但允许终态和footer，拒绝项计入丢弃', async () => {
  const f = fixture();
  const reserve = vi.fn((_bytes: number, control: boolean) => control);
  const writer = new BatchTraceWriter(f.sink, {}, { reserve });
  expect(writer.enqueue(record(1))).toBe(ETraceAdmission.FULL);
  expect(
    writer.enqueue({
      ...record(2),
      type: EAgentEventType.RUN_FINISHED,
      steps: 1,
      status: EAgentStatus.COMPLETE,
    }),
  ).toBe(ETraceAdmission.ACCEPTED);
  expect(await writer.close()).toMatchObject({
    written: 1,
    dropped: 1,
    status: ETraceWriteStatus.CLOSED,
  });
  expect(reserve).toHaveBeenCalledTimes(3);
});
it('后台首次失败只通知一次，通知异常不影响收尾', async () => {
  const f = fixture();
  f.write.mockRejectedValue(new Error('disk full'));
  f.close.mockRejectedValue(new Error('close failed'));
  const onError = vi.fn(() => {
    throw new Error('display failed');
  });
  const writer = new BatchTraceWriter(f.sink, {}, { onError });
  writer.enqueue(record(1));
  expect((await writer.close()).status).toBe(ETraceWriteStatus.FAILED);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(f.close).toHaveBeenCalledTimes(1);
});

it('容量钩子异常不能让close越过在途写入，失败后不再写后续批次', async () => {
  const f = fixture(true);
  const reserve = vi
    .fn()
    .mockReturnValueOnce(true)
    .mockReturnValueOnce(true)
    .mockImplementationOnce(() => {
      throw new Error('reservation failed');
    });
  const writer = new BatchTraceWriter(f.sink, { batchBytes: 1 }, { reserve });
  writer.enqueue(record(1));
  writer.enqueue(record(2));
  expect(writer.enqueue(record(3))).toBe(ETraceAdmission.FAILED);
  const closing = writer.close();
  await Promise.resolve();
  await Promise.resolve();
  try {
    expect(f.close).not.toHaveBeenCalled();
  } finally {
    f.release.resolve();
    await closing;
  }
  expect(f.write).toHaveBeenCalledTimes(1);
  expect(await writer.settled).toMatchObject({
    status: ETraceWriteStatus.FAILED,
    written: 1,
    writeFailed: 1,
  });
});
