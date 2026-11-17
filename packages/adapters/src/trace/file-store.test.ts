import {
  EAgentEventType,
  EAgentStatus,
  type TraceRecord,
} from '@ts-code-agent/core';
import {
  ETraceWriteError,
  ETraceAdmission,
  ETraceWriteStatus,
  ETraceFileRecordType,
} from './writer-types.js';
import { FileTraceSink } from './file-trace-sink.js';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileTraceStore, ETraceStoreError } from './file-store.js';

it('创建私有目录和锁，关闭幂等且释放后可重新取得锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const directory = join(root, 'traces');
  const store = await FileTraceStore.open({ directory });
  try {
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const lock = join(directory, '.writer.lock');
    expect((await stat(lock)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(lock, 'utf8'))).toMatchObject({
      pid: process.pid,
    });
    await expect(FileTraceStore.open({ directory })).rejects.toMatchObject({
      code: ETraceStoreError.LOCKED,
    });
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await closing;
    const next = await FileTraceStore.open({ directory });
    await next.close();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('并发初始化只有一个成功，不删除获胜者的锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  try {
    const results = await Promise.allSettled([
      FileTraceStore.open({ directory: root }),
      FileTraceStore.open({ directory: root }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        await result.value.close();
      } else {
        expect(result.reason).toMatchObject({ code: ETraceStoreError.LOCKED });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('不覆盖或删除已有未知锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const lock = join(root, '.writer.lock');
  try {
    await writeFile(lock, 'unknown owner');
    await expect(
      FileTraceStore.open({ directory: root }),
    ).rejects.toMatchObject({ code: ETraceStoreError.LOCKED });
    expect(await readFile(lock, 'utf8')).toBe('unknown owner');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('拒绝符号链接目录，不修改目标权限', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  try {
    const target = join(root, 'target');
    await mkdir(target, { mode: 0o700 });
    const directory = join(root, 'link');
    await symlink(target, directory);
    await expect(FileTraceStore.open({ directory })).rejects.toMatchObject({
      code: ETraceStoreError.UNSAFE_DIRECTORY,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('拒绝权限过宽的已有目录而不擅自修改权限', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  try {
    const directory = join(root, 'shared');
    await mkdir(directory, { mode: 0o755 });
    await expect(FileTraceStore.open({ directory })).rejects.toMatchObject({
      code: ETraceStoreError.UNSAFE_DIRECTORY,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('锁被外部替换后不删除替代锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({ directory: root });
  const path = join(root, '.writer.lock');
  try {
    await rm(path);
    await writeFile(path, 'replacement');
    await expect(store.close()).rejects.toMatchObject({
      code: ETraceStoreError.LOCK_CHANGED,
    });
    expect(await readFile(path, 'utf8')).toBe('replacement');
  } finally {
    await store.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

it('创建安全文件名、版本头和页脚，并在store关闭时等待writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({ directory: root });
  try {
    const { filePath } = await store.createWriter({ runId: '../用户/run' });
    expect(filePath.startsWith(root + '/trace-')).toBe(true);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await store.close();
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      type: 'trace.header',
      schemaVersion: 1,
      runId: '../用户/run',
    });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ type: 'trace.footer' });
    await expect(store.createWriter({ runId: 'late' })).rejects.toMatchObject({
      code: ETraceStoreError.CLOSED,
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('未知文件占用配额且不会被清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  await writeFile(join(root, 'keep'), Buffer.alloc(10000));
  const store = await FileTraceStore.open({
    directory: root,
    quotaBytes: 12000,
  });
  try {
    await expect(store.createWriter({ runId: 'quota' })).rejects.toMatchObject({
      code: ETraceStoreError.QUOTA,
    });
    expect((await stat(join(root, 'keep'))).size).toBe(10000);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function event(sequence: number): TraceRecord {
  return {
    schemaVersion: 1,
    sequence,
    runId: 'quota',
    elapsedMs: sequence,
    type: EAgentEventType.TEXT_DELTA,
    step: 1,
  };
}
it('普通配额耗尽后终态仍保存，文件关闭失败后下一轮仍能实际写入并释放目录锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({
    directory: root,
    quotaBytes: 8550,
  });
  const originalClose = FileTraceSink.prototype.close;
  const failedSinks: FileTraceSink[] = [];
  let reopened: FileTraceStore | undefined;
  const closeSpy = vi.spyOn(FileTraceSink.prototype, 'close');
  try {
    // 第一轮：普通配额耗尽，但预留空间仍允许保存终态。
    const first = await store.createWriter({ runId: 'quota' });
    expect(first.writer.enqueue(event(1))).toBe(ETraceAdmission.ACCEPTED);
    expect(first.writer.enqueue(event(2))).toBe(ETraceAdmission.FULL);
    const terminal: TraceRecord = {
      schemaVersion: 1,
      sequence: 3,
      runId: 'quota',
      elapsedMs: 3,
      type: EAgentEventType.RUN_FINISHED,
      status: EAgentStatus.COMPLETE,
      steps: 1,
    };
    expect(first.writer.enqueue(terminal)).toBe(ETraceAdmission.ACCEPTED);

    // 仅使本轮关闭拒绝；写入保持真实执行，真实句柄留到finally释放。
    closeSpy.mockImplementationOnce(function (this: FileTraceSink) {
      failedSinks.push(this);
      return Promise.reject(new Error('injected close failure'));
    });
    expect(await first.writer.close()).toMatchObject({
      status: ETraceWriteStatus.FAILED,
      errorCode: ETraceWriteError.CLOSE_FAILED,
      accepted: 2,
      written: 2,
      dropped: 1,
      writeFailed: 0,
      firstDroppedSequence: 2,
      lastDroppedSequence: 2,
    });
    const firstLines: unknown[] = (await readFile(first.filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(firstLines).toHaveLength(4);
    expect(firstLines).toMatchObject([
      { type: ETraceFileRecordType.HEADER, runId: 'quota' },
      { sequence: 1 },
      terminal,
      {
        type: ETraceFileRecordType.FOOTER,
        accepted: 2,
        written: 2,
        dropped: 1,
      },
    ]);

    // 小配额使创建下一轮必须回收已结算的旧文件，因此先完成上面的读取。
    closeSpy.mockRestore();
    const next = await store.createWriter({ runId: 'next' });
    await expect(stat(first.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(next.writer.enqueue({ ...event(1), runId: 'next' })).toBe(
      ETraceAdmission.ACCEPTED,
    );
    expect(
      next.writer.enqueue({ ...terminal, runId: 'next', sequence: 2 }),
    ).toBe(ETraceAdmission.ACCEPTED);
    expect(await next.writer.close()).toMatchObject({
      status: ETraceWriteStatus.CLOSED,
      accepted: 2,
      written: 2,
      dropped: 0,
    });
    const nextLines: unknown[] = (await readFile(next.filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(nextLines).toHaveLength(4);
    expect(nextLines).toMatchObject([
      { type: ETraceFileRecordType.HEADER, runId: 'next' },
      { type: EAgentEventType.TEXT_DELTA, runId: 'next', sequence: 1 },
      { type: EAgentEventType.RUN_FINISHED, runId: 'next', sequence: 2 },
      {
        type: ETraceFileRecordType.FOOTER,
        runId: 'next',
        written: 2,
        dropped: 0,
      },
    ]);

    // 会话结束后，同目录可由新的Store接管。
    await store.close();
    reopened = await FileTraceStore.open({ directory: root });
    await reopened.close();
  } finally {
    closeSpy.mockRestore();
    try {
      await Promise.all(failedSinks.map((sink) => originalClose.call(sink)));
    } finally {
      try {
        await store.close();
      } finally {
        try {
          await reopened?.close();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  }
});

it('同步配额拒绝普通记录但首次终态和页脚仍可写入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({
    directory: root,
    quotaBytes: 8550,
  });
  try {
    const { writer, filePath } = await store.createWriter({ runId: 'quota' });
    expect(writer.enqueue(event(1))).toBe(ETraceAdmission.ACCEPTED);
    expect(writer.enqueue(event(2))).toBe(ETraceAdmission.FULL);
    expect(
      writer.enqueue({
        schemaVersion: 1,
        sequence: 3,
        runId: 'quota',
        elapsedMs: 3,
        type: EAgentEventType.RUN_FINISHED,
        status: EAgentStatus.COMPLETE,
        steps: 1,
      }),
    ).toBe(ETraceAdmission.ACCEPTED);
    expect((await writer.close()).status).toBe(ETraceWriteStatus.CLOSED);
    const lines = (await readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line): unknown => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({
      type: ETraceFileRecordType.FOOTER,
      dropped: 1,
      written: 2,
    });
    expect((await stat(filePath)).size).toBeLessThanOrEqual(8550);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('保留清理只删除过期的已关闭轨迹，保护活动与未知文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({
    directory: root,
    retentionMs: 1000,
  });
  try {
    const old = await store.createWriter({ runId: 'old' });
    await old.writer.close();
    const active = await store.createWriter({ runId: 'active' });
    await writeFile(join(root, 'keep'), 'keep');
    const time = new Date(0);
    await utimes(old.filePath, time, time);
    await utimes(active.filePath, time, time);
    await store.createWriter({ runId: 'next' });
    await expect(stat(old.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(active.filePath)).isFile()).toBe(true);
    expect(await readFile(join(root, 'keep'), 'utf8')).toBe('keep');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('sink关闭失败仍报告失败，但下一轮可写且store最终释放目录锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({ directory: root });
  const original = FileTraceSink.prototype.close;
  const handles: FileTraceSink[] = [];
  const spy = vi
    .spyOn(FileTraceSink.prototype, 'close')
    .mockImplementation(function (this: FileTraceSink) {
      handles.push(this);
      return Promise.reject(new Error('close failed'));
    });
  try {
    const first = await store.createWriter({ runId: 'close-failed' });
    expect(await first.writer.close()).toMatchObject({
      status: ETraceWriteStatus.FAILED,
      errorCode: ETraceWriteError.CLOSE_FAILED,
    });
    spy.mockRestore();
    const next = await store.createWriter({ runId: 'next' });
    expect((await next.writer.close()).status).toBe(ETraceWriteStatus.CLOSED);
    await store.close();
    const reopened = await FileTraceStore.open({ directory: root });
    await reopened.close();
  } finally {
    spy.mockRestore();
    await Promise.all(handles.map((sink) => original.call(sink)));
    await rm(root, { recursive: true, force: true });
  }
});
it('确认原PID不存在后回收合法遗留锁，未知与活进程锁仍拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const lock = join(root, '.writer.lock');
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('missing'), { code: 'ESRCH' });
  });
  try {
    await writeFile(
      lock,
      JSON.stringify({
        schemaVersion: 1,
        pid: 12345678,
        token: '75087451-3f48-40a8-b1ad-147f2dc78609',
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const store = await FileTraceStore.open({ directory: root });
    expect(JSON.parse(await readFile(lock, 'utf8'))).toMatchObject({
      pid: process.pid,
    });
    await store.close();
  } finally {
    kill.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('重新打开时立即清理过期文件，无需创建下一次writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({ directory: root });
  const { filePath } = await store.createWriter({ runId: 'expired' });
  await store.close();
  await utimes(filePath, new Date(0), new Date(0));
  try {
    const next = await FileTraceStore.open({ directory: root });
    await next.close();
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('并发创建先获得同步配额预留且store.close等待已经开始的创建', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({
    directory: root,
    quotaBytes: 9000,
  });
  try {
    const first = store.createWriter({ runId: 'first' });
    const second = store.createWriter({ runId: 'second' });
    const failed = expect(second).rejects.toMatchObject({
      code: ETraceStoreError.QUOTA,
    });
    const closing = store.close();
    await failed;
    const { writer, filePath } = await first;
    await closing;
    expect((await writer.settled).status).toBe(ETraceWriteStatus.CLOSED);
    expect(await readFile(filePath, 'utf8')).toContain(
      ETraceFileRecordType.FOOTER,
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('PID校验权限错误不得接管锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const lock = join(root, '.writer.lock');
  const metadata = JSON.stringify({
    schemaVersion: 1,
    pid: 12345678,
    token: '75087451-3f48-40a8-b1ad-147f2dc78609',
    createdAt: new Date().toISOString(),
  });
  await writeFile(lock, metadata, { mode: 0o600 });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  });
  try {
    await expect(
      FileTraceStore.open({ directory: root }),
    ).rejects.toMatchObject({ code: ETraceStoreError.LOCKED });
    expect(await readFile(lock, 'utf8')).toBe(metadata);
  } finally {
    kill.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
it('未知恢复门锁阻止接管，不删除其内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const gate = join(root, '.writer.recovery.lock');
  await writeFile(gate, 'uncertain');
  try {
    await expect(
      FileTraceStore.open({ directory: root }),
    ).rejects.toMatchObject({ code: ETraceStoreError.LOCKED });
    expect(await readFile(gate, 'utf8')).toBe('uncertain');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('未知子目录中的文件也计入配额，且不清理未知内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  await mkdir(join(root, 'unknown'));
  await writeFile(join(root, 'unknown', 'keep'), Buffer.alloc(20000));
  const store = await FileTraceStore.open({
    directory: root,
    quotaBytes: 12000,
  });
  try {
    await expect(store.createWriter({ runId: 'nested' })).rejects.toMatchObject(
      { code: ETraceStoreError.QUOTA },
    );
    expect((await stat(join(root, 'unknown', 'keep'))).size).toBe(20000);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('writer超时报告后仍等真实关闭才释放锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({ directory: root });
  let release = () => {};
  let entered = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = FileTraceSink.prototype.close;
  const spy = vi
    .spyOn(FileTraceSink.prototype, 'close')
    .mockImplementation(async function (this: FileTraceSink) {
      entered();
      await blocked;
      await original.call(this);
    });
  try {
    const { writer } = await store.createWriter({
      runId: 'slow',
      writerOptions: { timeoutMs: 1 },
    });
    const writerClosing = writer.close();
    await started;
    const closing = store.close();
    expect((await writerClosing).status).toBe(ETraceWriteStatus.TIMED_OUT);
    await expect(
      FileTraceStore.open({ directory: root }),
    ).rejects.toMatchObject({ code: ETraceStoreError.LOCKED });
    release();
    await closing;
    const next = await FileTraceStore.open({ directory: root });
    await next.close();
  } finally {
    release();
    spy.mockRestore();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('没有事件的writer仍写入同runId的合法footer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({ directory: root });
  try {
    const { writer, filePath } = await store.createWriter({ runId: 'empty' });
    await writer.close();
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({
      type: ETraceFileRecordType.FOOTER,
      runId: 'empty',
      written: 0,
    });
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('未知目录过深时停止扫描并释放初始化锁', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  try {
    let directory = root;
    for (let depth = 0; depth < 65; depth++) {
      directory = join(directory, 'd');
      await mkdir(directory);
    }
    await expect(
      FileTraceStore.open({ directory: root }),
    ).rejects.toMatchObject({ code: ETraceStoreError.SCAN_LIMIT });
    await expect(stat(join(root, '.writer.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('初始化与关闭同时失败仍结算文件并允许目录重新打开', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({ directory: root });
  const original = FileTraceSink.prototype.close;
  const handles: FileTraceSink[] = [];
  const spy = vi
    .spyOn(FileTraceSink.prototype, 'close')
    .mockImplementation(function (this: FileTraceSink) {
      handles.push(this);
      return Promise.reject(new Error('close failed'));
    });
  try {
    await expect(
      store.createWriter({
        runId: 'invalid-options',
        writerOptions: { batchBytes: 0 },
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    await store.close();
    const next = await FileTraceStore.open({ directory: root });
    await next.close();
  } finally {
    spy.mockRestore();
    await Promise.all(handles.map((sink) => original.call(sink)));
    await rm(root, { recursive: true, force: true });
  }
});
it('无法结算实际占用时仍保留目录保护', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trace-store-'));
  const store = await FileTraceStore.open({ directory: root });
  try {
    const { writer, filePath } = await store.createWriter({ runId: 'missing' });
    await rm(filePath);
    expect((await writer.close()).status).toBe(ETraceWriteStatus.FAILED);
    await expect(store.close()).rejects.toMatchObject({
      code: ETraceStoreError.CLOSE_FAILED,
    });
    await expect(
      FileTraceStore.open({ directory: root }),
    ).rejects.toMatchObject({ code: ETraceStoreError.LOCKED });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
