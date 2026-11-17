import { open, type FileHandle } from 'node:fs/promises';
import type { TraceSink } from './writer-types.js';
import { ETraceSinkError, TraceSinkError, writeFully } from './write-fully.js';

enum EFileTraceSinkState {
  OPEN = 'open',
  FAILED = 'failed',
  CLOSING = 'closing',
  CLOSED = 'closed',
  CLOSE_FAILED = 'close_failed',
}
const TRACE_FILE_OPEN_FLAGS = 'wx';
const TRACE_FILE_MODE = 0o600;

/** Caller serializes writes and waits for them before closing (BatchTraceWriter does this). */
export class FileTraceSink implements TraceSink {
  private state = EFileTraceSinkState.OPEN;
  private closePromise: Promise<void> | undefined;

  private constructor(private readonly handle: FileHandle) {}

  static async open(filePath: string): Promise<FileTraceSink> {
    const handle = await open(filePath, TRACE_FILE_OPEN_FLAGS, TRACE_FILE_MODE);
    return new FileTraceSink(handle);
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.state !== EFileTraceSinkState.OPEN) {
      throw new TraceSinkError(ETraceSinkError.NOT_WRITABLE);
    }
    try {
      await writeFully(this.handle, bytes);
    } catch (error) {
      this.state = EFileTraceSinkState.FAILED;
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.state = EFileTraceSinkState.CLOSING;
    this.closePromise = this.closeHandle();
    return this.closePromise;
  }

  private async closeHandle(): Promise<void> {
    try {
      await this.handle.close();
      this.state = EFileTraceSinkState.CLOSED;
    } catch (error) {
      this.state = EFileTraceSinkState.CLOSE_FAILED;
      throw error;
    }
  }
}
