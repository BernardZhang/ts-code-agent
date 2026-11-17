export interface ByteWriter {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesWritten: number }>;
}

export enum ETraceSinkError {
  NOT_WRITABLE = 'trace_sink_not_writable',
  INVALID_WRITE_PROGRESS = 'trace_sink_invalid_write_progress',
}

export class TraceSinkError extends Error {
  constructor(readonly code: ETraceSinkError) {
    super(code);
    this.name = 'TraceSinkError';
  }
}

export async function writeFully(
  writer: ByteWriter,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const { bytesWritten } = await writer.write(bytes, offset, remaining, null);
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > remaining
    ) {
      throw new TraceSinkError(ETraceSinkError.INVALID_WRITE_PROGRESS);
    }
    offset += bytesWritten;
  }
}
