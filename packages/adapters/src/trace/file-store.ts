import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  opendir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BatchTraceWriter } from './batch-writer.js';
import { FileTraceSink } from './file-trace-sink.js';
import {
  ETraceFileRecordType,
  type TraceWriterOptions,
  type TraceWriterHooks,
} from './writer-types.js';
import { writeFully } from './write-fully.js';

export enum ETraceStoreError {
  SCAN_LIMIT = 'trace_store_scan_limit',
  CLOSE_FAILED = 'trace_store_close_failed',
  CLOSED = 'trace_store_closed',
  QUOTA = 'trace_store_quota',
  INVALID_RUN_ID = 'trace_store_invalid_run_id',
  LOCKED = 'trace_store_locked',
  UNSAFE_DIRECTORY = 'trace_store_unsafe_directory',
  LOCK_CHANGED = 'trace_store_lock_changed',
}
export class TraceStoreError extends Error {
  constructor(readonly code: ETraceStoreError) {
    super(code);
    this.name = 'TraceStoreError';
  }
}
const LOCK_NAME = '.writer.lock';
const EXCLUSIVE_CREATE = 'wx';
const FILE_EXISTS = 'EEXIST';
const FILE_MISSING = 'ENOENT';
const PROCESS_MISSING = 'ESRCH';
const RECOVERY_NAME = '.writer.recovery.lock';
const MAX_LOCK_BYTES = 4096;
const DIRECTORY_MODE = 0o700;
const LOCK_MODE = 0o600;

const MAX_SCAN_ENTRIES = 10000;
const MAX_SCAN_DEPTH = 64;
const CONTROL_BYTES = 8192;
const DEFAULT_QUOTA = 256 * 1024 * 1024;
const DEFAULT_RETENTION = 7 * 24 * 60 * 60 * 1000;
const OWNED_NAME = /^trace-[a-f0-9]{64}-[a-f0-9-]{36}\.jsonl$/;
export interface FileTraceStoreOptions {
  directory: string;
  quotaBytes?: number;
  retentionMs?: number;
}
interface ActiveFile {
  reserved: number;
  controlLeft: number;
  writer?: BatchTraceWriter;
}
/** Single cooperating process owns this directory until all writer IO has settled. */
export class FileTraceStore {
  private serial: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, ActiveFile>();
  private diskBytes = 0;
  private closePromise: Promise<void> | undefined;

  private constructor(
    readonly directory: string,
    private readonly lockPath: string,
    private readonly lock: FileHandle,
    private readonly quotaBytes: number,
    private readonly retentionMs: number,
  ) {}

  static async open(options: FileTraceStoreOptions): Promise<FileTraceStore> {
    const quota = options.quotaBytes ?? DEFAULT_QUOTA;
    const retention = options.retentionMs ?? DEFAULT_RETENTION;
    if (
      !Number.isSafeInteger(quota) ||
      quota <= 0 ||
      !Number.isSafeInteger(retention) ||
      retention < 0
    ) {
      throw new RangeError('追踪配额和保留期无效');
    }
    const directory = resolve(options.directory);
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      (info.mode & 0o777) !== DIRECTORY_MODE ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    ) {
      throw new TraceStoreError(ETraceStoreError.UNSAFE_DIRECTORY);
    }
    const lockPath = join(directory, LOCK_NAME);
    const lock = await acquireLock(directory, lockPath);
    const store = new FileTraceStore(
      directory,
      lockPath,
      lock,
      quota,
      retention,
    );
    try {
      const owner = {
        schemaVersion: 1,
        pid: process.pid,
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await writeFully(
        lock,
        new TextEncoder().encode(JSON.stringify(owner) + '\n'),
      );
      await store.cleanup();
      return store;
    } catch (error) {
      try {
        await store.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Trace store initialization and cleanup failed',
        );
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.finish();
    return this.closePromise;
  }

  createWriter(options: {
    runId: string;
    writerOptions?: Partial<TraceWriterOptions>;
    hooks?: TraceWriterHooks;
  }): Promise<{ filePath: string; writer: BatchTraceWriter }> {
    if (this.closePromise) {
      return Promise.reject(new TraceStoreError(ETraceStoreError.CLOSED));
    }
    return this.exclusive(async () => {
      if (
        typeof options.runId !== 'string' ||
        options.runId.length === 0 ||
        Buffer.byteLength(options.runId) > 128
      ) {
        throw new TraceStoreError(ETraceStoreError.INVALID_RUN_ID);
      }
      const header = Buffer.from(
        JSON.stringify({
          type: ETraceFileRecordType.HEADER,
          schemaVersion: 1,
          runId: options.runId,
          createdAt: new Date().toISOString(),
        }) + '\n',
      );
      const required = header.length + CONTROL_BYTES;
      await this.cleanup(required);
      if (this.usage() + required > this.quotaBytes) {
        throw new TraceStoreError(ETraceStoreError.QUOTA);
      }
      const name = `trace-${createHash('sha256').update(options.runId).digest('hex')}-${randomUUID()}.jsonl`;
      const filePath = join(this.directory, name);
      const entry: ActiveFile = {
        reserved: required,
        controlLeft: CONTROL_BYTES,
      };
      this.active.set(filePath, entry);
      let sink: FileTraceSink | undefined;
      try {
        sink = await FileTraceSink.open(filePath);
        const fileSink = sink;
        const writer = new BatchTraceWriter(
          {
            write: (bytes) => fileSink.write(bytes),
            close: async () => {
              try {
                await fileSink.close();
              } finally {
                // Writer has awaited all writes; a rejected close cannot resume writing.
                // A pending close never reaches this reconciliation.
                await this.exclusive(() => this.reconcileFile(filePath));
              }
            },
          },
          options.writerOptions,
          {
            ...options.hooks,
            reserve: (bytes, control) => {
              if (control) {
                if (bytes > entry.controlLeft) {
                  return false;
                }
                if (
                  options.hooks?.reserve &&
                  !options.hooks.reserve(bytes, control)
                ) {
                  return false;
                }
                entry.controlLeft -= bytes;
                return true;
              }
              if (this.usage() + bytes > this.quotaBytes) {
                return false;
              }
              if (
                options.hooks?.reserve &&
                !options.hooks.reserve(bytes, control)
              ) {
                return false;
              }
              entry.reserved += bytes;
              return true;
            },
          },
          options.runId,
        );
        await sink.write(header);
        entry.writer = writer;
        return { filePath, writer };
      } catch (error) {
        if (sink) {
          try {
            await sink.close();
          } catch (closeError) {
            try {
              // Already inside exclusive: do not enqueue behind ourselves.
              await this.reconcileFile(filePath);
            } catch (accountingError) {
              throw new AggregateError(
                [error, closeError, accountingError],
                'Trace initialization, close and accounting failed',
              );
            }
            throw new AggregateError(
              [error, closeError],
              'Trace initialization and close failed',
            );
          }
        }
        // Reconcile partial header writes; never refund an uncertain stat.
        try {
          this.diskBytes += (await lstat(filePath)).size;
        } catch (statError) {
          if (
            !(
              statError instanceof Error &&
              'code' in statError &&
              statError.code === FILE_MISSING
            )
          ) {
            throw statError;
          }
        }
        this.active.delete(filePath);
        throw error;
      }
    });
  }

  private async reconcileFile(filePath: string): Promise<void> {
    const actual = await lstat(filePath);
    this.active.delete(filePath);
    this.diskBytes += actual.size;
    await this.cleanup();
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private usage(): number {
    let total = this.diskBytes;
    for (const entry of this.active.values()) {
      total += entry.reserved;
    }
    return total;
  }

  private async cleanup(required = 0): Promise<void> {
    let diskBytes = 0;
    const candidates: {
      path: string;
      size: number;
      modified: number;
      dev: number;
      ino: number;
    }[] = [];
    const budget = { remaining: MAX_SCAN_ENTRIES };
    for await (const item of await opendir(this.directory)) {
      consumeEntry(budget);
      const name = item.name;
      const path = join(this.directory, name);
      if (this.active.has(path)) {
        continue;
      }
      const info = await lstat(path);
      diskBytes += info.isDirectory()
        ? await directoryBytes(path, budget, 1)
        : info.size;
      if (info.isFile() && info.nlink === 1 && OWNED_NAME.test(name)) {
        candidates.push({
          path,
          size: info.size,
          modified: info.mtimeMs,
          dev: info.dev,
          ino: info.ino,
        });
      }
    }
    this.diskBytes = diskBytes;
    candidates.sort((a, b) => a.modified - b.modified);
    const cutoff = Date.now() - this.retentionMs;
    for (const file of candidates) {
      if (
        file.modified > cutoff &&
        this.usage() + required <= this.quotaBytes
      ) {
        continue;
      }
      const current = await lstat(file.path);
      if (
        !current.isFile() ||
        current.dev !== file.dev ||
        current.ino !== file.ino
      ) {
        continue;
      }
      await unlink(file.path);
      this.diskBytes -= file.size;
    }
  }

  private async finish(): Promise<void> {
    await this.serial;
    const writers = [...this.active.values()].flatMap((entry) =>
      entry.writer ? [entry.writer] : [],
    );
    for (const writer of writers) {
      void writer.close();
    }
    await Promise.all(writers.map((writer) => writer.settled));
    await this.serial;
    if (this.active.size > 0) {
      // Unreconciled file occupancy keeps the ownership marker. Closing this
      // lock descriptor is safe; the live PID still prevents takeover.
      await this.lock.close();
      throw new TraceStoreError(ETraceStoreError.CLOSE_FAILED);
    }
    await this.releaseLock();
  }

  private async releaseLock(): Promise<void> {
    try {
      const held = await this.lock.stat();
      const current = await lstat(this.lockPath);
      if (
        !current.isFile() ||
        held.dev !== current.dev ||
        held.ino !== current.ino
      ) {
        throw new TraceStoreError(ETraceStoreError.LOCK_CHANGED);
      }
      await unlink(this.lockPath);
    } finally {
      await this.lock.close();
    }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function acquireLock(
  directory: string,
  lockPath: string,
): Promise<FileHandle> {
  const gatePath = join(directory, RECOVERY_NAME);
  let gate: FileHandle;
  try {
    gate = await open(gatePath, EXCLUSIVE_CREATE, LOCK_MODE);
  } catch (error) {
    if (hasCode(error, FILE_EXISTS)) {
      throw new TraceStoreError(ETraceStoreError.LOCKED);
    }
    throw error;
  }
  try {
    try {
      return await open(lockPath, EXCLUSIVE_CREATE, LOCK_MODE);
    } catch (error) {
      if (!hasCode(error, FILE_EXISTS)) {
        throw error;
      }
    }
    await recoverDeadOwner(lockPath);
    return await open(lockPath, EXCLUSIVE_CREATE, LOCK_MODE);
  } finally {
    try {
      const held = await gate.stat();
      const current = await lstat(gatePath);
      if (
        current.isFile() &&
        held.dev === current.dev &&
        held.ino === current.ino
      ) {
        await unlink(gatePath);
      }
    } finally {
      await gate.close();
    }
  }
}

async function recoverDeadOwner(lockPath: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(lockPath);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== LOCK_MODE ||
      before.size > MAX_LOCK_BYTES ||
      (process.getuid && before.uid !== process.getuid())
    ) {
      throw new TraceStoreError(ETraceStoreError.LOCKED);
    }
    handle = await open(
      lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const held = await handle.stat();
    if (held.dev !== before.dev || held.ino !== before.ino) {
      throw new TraceStoreError(ETraceStoreError.LOCKED);
    }
    const bytes = Buffer.alloc(MAX_LOCK_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_LOCK_BYTES) {
      throw new TraceStoreError(ETraceStoreError.LOCKED);
    }
    const owner: unknown = JSON.parse(
      bytes.subarray(0, bytesRead).toString('utf8'),
    );
    if (
      typeof owner !== 'object' ||
      owner === null ||
      !('schemaVersion' in owner) ||
      owner.schemaVersion !== 1 ||
      !('pid' in owner) ||
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !('token' in owner) ||
      typeof owner.token !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        owner.token,
      ) ||
      !('createdAt' in owner) ||
      typeof owner.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(owner.createdAt))
    ) {
      throw new TraceStoreError(ETraceStoreError.LOCKED);
    }
    let dead = false;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      dead = hasCode(error, PROCESS_MISSING);
    }
    if (!dead) {
      throw new TraceStoreError(ETraceStoreError.LOCKED);
    }
    const current = await lstat(lockPath);
    if (
      !current.isFile() ||
      current.dev !== held.dev ||
      current.ino !== held.ino
    ) {
      throw new TraceStoreError(ETraceStoreError.LOCKED);
    }
    await unlink(lockPath);
  } catch (error) {
    if (error instanceof TraceStoreError) {
      throw error;
    }
    throw new TraceStoreError(ETraceStoreError.LOCKED);
  } finally {
    await handle?.close();
  }
}

/** Never follows symlinks; unknown content consumes quota but is never deleted. */
function consumeEntry(budget: { remaining: number }): void {
  if (--budget.remaining < 0) {
    throw new TraceStoreError(ETraceStoreError.SCAN_LIMIT);
  }
}
async function directoryBytes(
  directory: string,
  budget: { remaining: number },
  depth: number,
): Promise<number> {
  if (depth > MAX_SCAN_DEPTH) {
    throw new TraceStoreError(ETraceStoreError.SCAN_LIMIT);
  }
  let bytes = (await lstat(directory)).size;
  for await (const item of await opendir(directory)) {
    consumeEntry(budget);
    const path = join(directory, item.name);
    const info = await lstat(path);
    bytes += info.isDirectory()
      ? await directoryBytes(path, budget, depth + 1)
      : info.size;
  }
  return bytes;
}
