import { EAgentEventType, type TraceRecord } from '@ts-code-agent/core';
import {
  ETraceAdmission,
  ETraceFileRecordType,
  ETraceWriteError,
  ETraceWriteStatus,
  type TraceSink,
  type TraceWriteReport,
  type TraceWriterOptions,
  type TraceWriterHooks,
} from './writer-types.js';

const DEFAULTS: TraceWriterOptions = {
  batchBytes: 64 * 1024,
  intervalMs: 100,
  maxPendingBytes: 1024 * 1024,
  maxRecordBytes: 64 * 1024,
  timeoutMs: 5000,
};
const CONTROL_SLOT_BYTES = 4096;
const MAX_TIMER_MS = 2_147_483_647;
interface Entry {
  bytes: Uint8Array;
  control: boolean;
}
interface Barrier {
  target: number;
  report: TraceWriteReport;
  resolve: (report: TraceWriteReport) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Synchronous bounded admission with one serialized asynchronous sink writer. */
export class BatchTraceWriter {
  readonly settled: Promise<TraceWriteReport>;
  private settle!: (report: TraceWriteReport) => void;
  private readonly options: TraceWriterOptions;
  private readonly encoder = new TextEncoder();
  private readonly queue: Entry[] = [];
  private readonly barriers: Barrier[] = [];
  private pendingBytes = 0;
  private inFlight = false;
  private drainPromise: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private terminalAccepted = false;
  private closing = false;
  private closePromise: Promise<TraceWriteReport> | undefined;
  private errorCode: ETraceWriteError | undefined;
  private runId: string | undefined;
  private readonly counts = {
    accepted: 0,
    written: 0,
    dropped: 0,
    oversized: 0,
    lastReceivedSequence: 0,
  };
  private firstDroppedSequence: number | undefined;
  private lastDroppedSequence: number | undefined;

  constructor(
    private readonly sink: TraceSink,
    options: Partial<TraceWriterOptions> = {},
    private readonly hooks: TraceWriterHooks = {},
    initialRunId?: string,
  ) {
    this.runId = initialRunId;
    this.options = { ...DEFAULTS, ...options };
    for (const value of Object.values(this.options)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError('追踪写入参数必须为正安全整数');
      }
    }
    if (
      this.options.intervalMs > MAX_TIMER_MS ||
      this.options.timeoutMs > MAX_TIMER_MS
    ) {
      throw new RangeError('追踪计时器超出允许范围');
    }
    this.settled = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  enqueue(record: TraceRecord): ETraceAdmission {
    if (this.errorCode !== undefined) {
      return ETraceAdmission.FAILED;
    }
    if (this.closing) {
      return ETraceAdmission.CLOSED;
    }
    if (
      !Number.isSafeInteger(record.sequence) ||
      record.sequence <= this.counts.lastReceivedSequence ||
      (this.runId !== undefined && record.runId !== this.runId)
    ) {
      return ETraceAdmission.INVALID;
    }
    this.runId ??= record.runId;
    this.counts.lastReceivedSequence = record.sequence;
    let bytes: Uint8Array;
    try {
      bytes = this.encoder.encode(JSON.stringify(record) + '\n');
    } catch {
      return this.drop(record.sequence, ETraceAdmission.INVALID);
    }
    const control =
      record.type === EAgentEventType.RUN_FINISHED && !this.terminalAccepted;
    if (
      bytes.length > this.options.maxRecordBytes ||
      (control && bytes.length > CONTROL_SLOT_BYTES)
    ) {
      return this.drop(record.sequence, ETraceAdmission.OVERSIZED);
    }
    if (
      !control &&
      this.pendingBytes + bytes.length > this.options.maxPendingBytes
    ) {
      return this.drop(record.sequence, ETraceAdmission.FULL);
    }
    try {
      if (this.hooks.reserve?.(bytes.length, control) === false) {
        return this.drop(record.sequence, ETraceAdmission.FULL);
      }
    } catch {
      this.fail(ETraceWriteError.WRITE_FAILED);
      return this.drop(record.sequence, ETraceAdmission.FAILED);
    }
    if (control) {
      this.terminalAccepted = true;
    } else {
      this.pendingBytes += bytes.length;
    }
    this.counts.accepted++;
    this.queue.push({ bytes, control });
    if (this.pendingBytes >= this.options.batchBytes || control) {
      this.kick();
    } else {
      this.schedule();
    }
    return ETraceAdmission.ACCEPTED;
  }

  flush(): Promise<TraceWriteReport> {
    if (this.closing) {
      return this.closePromise ?? this.settled;
    }
    return this.barrier(this.options.timeoutMs);
  }

  close(): Promise<TraceWriteReport> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closing = true;
    this.clearTimer();
    this.closePromise = this.withTimeout(this.settled);
    void this.finish();
    return this.closePromise;
  }

  private drop(sequence: number, reason: ETraceAdmission): ETraceAdmission {
    this.counts.dropped++;
    if (reason === ETraceAdmission.OVERSIZED) {
      this.counts.oversized++;
    }
    this.firstDroppedSequence ??= sequence;
    this.lastDroppedSequence = sequence;
    return reason;
  }

  private report(status: ETraceWriteStatus): TraceWriteReport {
    return {
      ...this.counts,
      status,
      writeFailed:
        this.errorCode === ETraceWriteError.WRITE_FAILED
          ? this.counts.accepted - this.counts.written
          : 0,
      ...(this.firstDroppedSequence === undefined
        ? {}
        : { firstDroppedSequence: this.firstDroppedSequence }),
      ...(this.lastDroppedSequence === undefined
        ? {}
        : { lastDroppedSequence: this.lastDroppedSequence }),
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    };
  }

  private barrier(timeoutMs?: number): Promise<TraceWriteReport> {
    const report = this.report(ETraceWriteStatus.FLUSHED);
    if (this.errorCode !== undefined) {
      return Promise.resolve(this.report(ETraceWriteStatus.FAILED));
    }
    if (report.accepted === this.counts.written) {
      return Promise.resolve(report);
    }
    const promise = new Promise<TraceWriteReport>((resolve) => {
      const barrier: Barrier = {
        target: report.accepted,
        report,
        resolve,
      };
      this.barriers.push(barrier);

      if (timeoutMs !== undefined) {
        barrier.timer = setTimeout(() => {
          const index = this.barriers.indexOf(barrier);
          if (index === -1) {
            return;
          }
          this.barriers.splice(index, 1);
          resolve(this.report(ETraceWriteStatus.TIMED_OUT));
        }, timeoutMs);
      }
    });
    this.kick();
    return promise;
  }

  private releaseBarriers() {
    for (let i = this.barriers.length - 1; i >= 0; i--) {
      const barrier = this.barriers[i];
      if (
        barrier &&
        (this.errorCode !== undefined || this.counts.written >= barrier.target)
      ) {
        this.barriers.splice(i, 1);
        if (barrier.timer !== undefined) {
          clearTimeout(barrier.timer);
        }
        barrier.resolve(
          this.errorCode === undefined
            ? { ...barrier.report, written: barrier.target }
            : this.report(ETraceWriteStatus.FAILED),
        );
      }
    }
  }

  private schedule() {
    if (this.timer === undefined && !this.inFlight) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.kick();
      }, this.options.intervalMs);
    }
  }

  private clearTimer() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;
  }

  private kick() {
    if (
      this.inFlight ||
      this.errorCode !== undefined ||
      this.queue.length === 0
    ) {
      return;
    }
    this.clearTimer();
    this.inFlight = true;
    this.drainPromise = this.drain();
  }

  private async drain() {
    try {
      while (this.queue.length > 0 && this.errorCode === undefined) {
        const batch: Entry[] = [];
        let size = 0;
        while (
          this.queue[0] &&
          (size === 0 ||
            size + this.queue[0].bytes.length <= this.options.batchBytes)
        ) {
          const entry = this.queue.shift();
          if (entry) {
            batch.push(entry);
            size += entry.bytes.length;
          }
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const entry of batch) {
          bytes.set(entry.bytes, offset);
          offset += entry.bytes.length;
        }
        await this.sink.write(bytes);
        for (const entry of batch) {
          if (!entry.control) {
            this.pendingBytes -= entry.bytes.length;
          }
        }
        this.counts.written += batch.length;
        this.releaseBarriers();
      }
    } catch {
      this.fail(ETraceWriteError.WRITE_FAILED);
      this.queue.length = 0;
      this.pendingBytes = 0;
      this.releaseBarriers();
    } finally {
      if (this.errorCode !== undefined) {
        this.queue.length = 0;
        this.pendingBytes = 0;
      }
      this.inFlight = false;
    }
  }

  private async finish() {
    await this.barrier();
    await this.drainPromise;
    if (this.errorCode === undefined) {
      const footer = {
        type: ETraceFileRecordType.FOOTER,
        schemaVersion: 1,
        runId: this.runId,
        ...this.report(ETraceWriteStatus.CLOSED),
      };
      const bytes = this.encoder.encode(JSON.stringify(footer) + '\n');
      try {
        if (
          bytes.length > CONTROL_SLOT_BYTES ||
          this.hooks.reserve?.(bytes.length, true) === false
        ) {
          throw new RangeError('追踪页脚超限');
        }
        await this.sink.write(bytes);
      } catch {
        this.fail(ETraceWriteError.WRITE_FAILED);
      }
    }
    try {
      await this.sink.close();
    } catch {
      this.fail(ETraceWriteError.CLOSE_FAILED);
    }
    this.settle(
      this.report(
        this.errorCode === undefined
          ? ETraceWriteStatus.CLOSED
          : ETraceWriteStatus.FAILED,
      ),
    );
  }

  private fail(code: ETraceWriteError): void {
    if (this.errorCode !== undefined) {
      return;
    }
    this.errorCode = code;
    this.queue.length = 0;
    if (!this.inFlight) {
      this.pendingBytes = 0;
    }
    this.clearTimer();
    this.releaseBarriers();
    try {
      this.hooks.onError?.(this.report(ETraceWriteStatus.FAILED));
    } catch {
      // Diagnostic display failures must not interrupt writer cleanup.
    }
  }

  private withTimeout(
    promise: Promise<TraceWriteReport>,
  ): Promise<TraceWriteReport> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve(this.report(ETraceWriteStatus.TIMED_OUT)),
        this.options.timeoutMs,
      );
      void promise.then((report) => {
        clearTimeout(timer);
        resolve(report);
      });
    });
  }
}
