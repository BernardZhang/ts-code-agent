export interface TraceSink {
  /** Resolve only after every supplied byte has been written. Partial writes belong to the sink. */
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
export enum ETraceAdmission {
  ACCEPTED = 'accepted',
  FULL = 'full',
  OVERSIZED = 'oversized',
  CLOSED = 'closed',
  FAILED = 'failed',
  INVALID = 'invalid',
}
export enum ETraceWriteStatus {
  FLUSHED = 'flushed',
  CLOSED = 'closed',
  FAILED = 'failed',
  TIMED_OUT = 'timed_out',
}
export enum ETraceWriteError {
  WRITE_FAILED = 'write_failed',
  CLOSE_FAILED = 'close_failed',
}
export enum ETraceFileRecordType {
  HEADER = 'trace.header',
  FOOTER = 'trace.footer',
}
export interface TraceWriteReport {
  status: ETraceWriteStatus;
  accepted: number;
  written: number;
  dropped: number;
  oversized: number;
  writeFailed: number;
  lastReceivedSequence: number;
  firstDroppedSequence?: number;
  lastDroppedSequence?: number;
  errorCode?: ETraceWriteError;
}
export interface TraceWriterOptions {
  batchBytes: number;
  intervalMs: number;
  maxPendingBytes: number;
  maxRecordBytes: number;
  timeoutMs: number;
}

/** reserve is synchronous; false refuses admission without changing disk contents. */
export interface TraceWriterHooks {
  reserve?: (bytes: number, control: boolean) => boolean;
  onError?: (report: TraceWriteReport) => void;
}
