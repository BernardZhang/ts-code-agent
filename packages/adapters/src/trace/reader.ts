import { createReadStream } from 'node:fs';
import { z } from 'zod';
import {
  EAgentEventType,
  EAgentStatus,
  EAgentRunFailure,
  ModelErrorCode,
  EContextErrorCode,
  ToolErrorCode,
  type TraceRecord,
} from '@ts-code-agent/core';
import {
  ETraceFileRecordType,
  ETraceWriteStatus,
  ETraceWriteError,
} from './writer-types.js';

export const MAX_TRACE_LINE_BYTES = 64 * 1024;
export enum ETraceReadItemType {
  RECORD = 'record',
  DIAGNOSTIC = 'diagnostic',
}
export enum ETraceReadDiagnostic {
  INVALID_JSON = 'invalid_json',
  INVALID_UTF8 = 'invalid_utf8',
  INVALID_RECORD = 'invalid_record',
  UNKNOWN_VERSION = 'unknown_version',
  LINE_TOO_LONG = 'line_too_long',
  TRUNCATED = 'truncated',
  MISSING_HEADER = 'missing_header',
  MISSING_FOOTER = 'missing_footer',
  MISSING_RUN_FINISHED = 'missing_run_finished',
  SEQUENCE_GAP = 'sequence_gap',
  OUT_OF_ORDER = 'out_of_order',
  RUN_ID_MISMATCH = 'run_id_mismatch',
  AFTER_FOOTER = 'after_footer',
  DUPLICATE_HEADER = 'duplicate_header',
  AFTER_TERMINAL = 'after_terminal',
  FOOTER_MISMATCH = 'footer_mismatch',
  INCOMPLETE_WRITE = 'incomplete_write',
  MISSING_RUN_STARTED = 'missing_run_started',
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = (max: number) =>
  z
    .string()
    .min(1)
    .refine((s) => Buffer.byteLength(s) <= max);
const envelope = { schemaVersion: z.literal(1), runId: name(128) };
const headerSchema = z.object({
  ...envelope,
  type: z.literal(ETraceFileRecordType.HEADER),
  createdAt: z.iso.datetime(),
});
const footerSchema = z.object({
  ...envelope,
  type: z.literal(ETraceFileRecordType.FOOTER),
  status: z.enum(ETraceWriteStatus),
  accepted: count,
  written: count,
  dropped: count,
  oversized: count,
  writeFailed: count,
  lastReceivedSequence: count,
  firstDroppedSequence: count.optional(),
  lastDroppedSequence: count.optional(),
  errorCode: z.enum(ETraceWriteError).optional(),
});
const base = {
  ...envelope,
  sequence: count.positive(),
  elapsedMs: z.number().nonnegative().finite(),
};
const step = { step: count.positive() };
const tool = { ...step, toolCallId: name(128), toolName: name(256) };
const eventSchema = z.union([
  z.object({ ...base, type: z.literal(EAgentEventType.RUN_STARTED) }),
  z.object({
    ...base,
    type: z.enum([EAgentEventType.MODEL_STARTED, EAgentEventType.TEXT_DELTA]),
    ...step,
  }),
  z.object({
    ...base,
    type: z.literal(EAgentEventType.MODEL_FINISHED),
    ...step,
    usage: z
      .object({
        inputTokens: count.optional(),
        outputTokens: count.optional(),
      })
      .transform((value) => ({
        ...(value.inputTokens === undefined
          ? {}
          : { inputTokens: value.inputTokens }),
        ...(value.outputTokens === undefined
          ? {}
          : { outputTokens: value.outputTokens }),
      })),
  }),
  z.object({
    ...base,
    type: z.enum([
      EAgentEventType.TOOL_CALL_READY,
      EAgentEventType.TOOL_CALL_STARTED,
    ]),
    ...tool,
  }),
  z.object({
    ...base,
    type: z.literal(EAgentEventType.TOOL_CALL_FINISHED),
    ...tool,
    success: z.literal(true),
  }),
  z.object({
    ...base,
    type: z.literal(EAgentEventType.TOOL_CALL_FINISHED),
    ...tool,
    success: z.literal(false),
    errorCode: z.enum(ToolErrorCode),
  }),
  z.object({
    ...base,
    type: z.literal(EAgentEventType.RUN_FINISHED),
    steps: count,
    status: z.union([z.enum(EAgentStatus), z.enum(EAgentRunFailure)]),
    errorCode: z
      .union([z.enum(ModelErrorCode), z.enum(EContextErrorCode)])
      .optional(),
  }),
]);
const schema = z
  .union([headerSchema, footerSchema, eventSchema])
  .transform((record) => {
    if (record.type === EAgentEventType.RUN_FINISHED) {
      const { errorCode, ...rest } = record;
      return { ...rest, ...(errorCode === undefined ? {} : { errorCode }) };
    }
    return record;
  });
export type TraceHeader = z.infer<typeof headerSchema>;
export type TraceFooter = z.infer<typeof footerSchema>;
export type TraceReadItem =
  | {
      type: ETraceReadItemType.RECORD;
      line: number;
      record: TraceHeader | TraceFooter | TraceRecord;
    }
  | {
      type: ETraceReadItemType.DIAGNOSTIC;
      line: number;
      code: ETraceReadDiagnostic;
    };
interface Line {
  bytes: Buffer;
  oversized: boolean;
  terminated: boolean;
}
/** Fixed scratch space; oversized input is discarded until the next newline. */
async function* lines(path: string, signal?: AbortSignal): AsyncIterable<Line> {
  signal?.throwIfAborted();
  const stream = createReadStream(path, {
    highWaterMark: 16 * 1024,
    ...(signal ? { signal } : {}),
  });
  const buffer = Buffer.alloc(MAX_TRACE_LINE_BYTES);
  let length = 0;
  let oversized = false;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError('Expected byte stream');
      }
      for (const byte of chunk) {
        if (byte === 10) {
          signal?.throwIfAborted();
          yield {
            bytes: Buffer.from(buffer.subarray(0, length)),
            oversized,
            terminated: true,
          };
          length = 0;
          oversized = false;
        } else if (length < MAX_TRACE_LINE_BYTES) {
          buffer[length++] = byte;
        } else {
          oversized = true;
        }
      }
    }
    signal?.throwIfAborted();
    if (length > 0 || oversized) {
      yield { bytes: buffer.subarray(0, length), oversized, terminated: false };
    }
  } finally {
    stream.destroy();
  }
}
/** Read-only diagnosis. A footer acknowledges writes, never fsync durability. */
export async function* readTrace(
  path: string,
  signal?: AbortSignal,
): AsyncIterable<TraceReadItem> {
  let line = 0,
    runId: string | undefined,
    header = false,
    footer = false,
    started = false,
    finished = false,
    sequence = 0,
    records = 0;
  const diagnostic = (code: ETraceReadDiagnostic): TraceReadItem => ({
    type: ETraceReadItemType.DIAGNOSTIC,
    line,
    code,
  });
  for await (const entry of lines(path, signal)) {
    signal?.throwIfAborted();
    line++;
    if (footer) {
      yield diagnostic(ETraceReadDiagnostic.AFTER_FOOTER);
    }
    if (!entry.terminated) {
      yield diagnostic(ETraceReadDiagnostic.TRUNCATED);
    }
    if (entry.oversized) {
      yield diagnostic(ETraceReadDiagnostic.LINE_TOO_LONG);
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
    } catch {
      yield diagnostic(ETraceReadDiagnostic.INVALID_UTF8);
      continue;
    }
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      yield diagnostic(ETraceReadDiagnostic.INVALID_JSON);
      continue;
    }
    if (
      typeof input === 'object' &&
      input !== null &&
      'schemaVersion' in input &&
      input.schemaVersion !== 1
    ) {
      yield diagnostic(ETraceReadDiagnostic.UNKNOWN_VERSION);
      continue;
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      yield diagnostic(ETraceReadDiagnostic.INVALID_RECORD);
      continue;
    }
    const record = parsed.data;
    if (runId !== undefined && runId !== record.runId) {
      yield diagnostic(ETraceReadDiagnostic.RUN_ID_MISMATCH);
      continue;
    }
    runId ??= record.runId;
    if (record.type === ETraceFileRecordType.HEADER) {
      if (header) {
        yield diagnostic(ETraceReadDiagnostic.DUPLICATE_HEADER);
      }
      if (line !== 1) {
        yield diagnostic(ETraceReadDiagnostic.OUT_OF_ORDER);
      }
      header = true;
    } else if (record.type === ETraceFileRecordType.FOOTER) {
      footer = true;
      if (
        record.written !== records ||
        record.accepted !== record.written ||
        record.lastReceivedSequence < sequence
      ) {
        yield diagnostic(ETraceReadDiagnostic.FOOTER_MISMATCH);
      }
      if (record.lastReceivedSequence > sequence) {
        yield diagnostic(ETraceReadDiagnostic.SEQUENCE_GAP);
      }
      if (
        record.status !== ETraceWriteStatus.CLOSED ||
        record.dropped > 0 ||
        record.oversized > 0 ||
        record.writeFailed > 0 ||
        record.errorCode !== undefined
      ) {
        yield diagnostic(ETraceReadDiagnostic.INCOMPLETE_WRITE);
      }
    } else {
      records++;
      if (record.sequence <= sequence) {
        yield diagnostic(ETraceReadDiagnostic.OUT_OF_ORDER);
      } else if (record.sequence !== sequence + 1) {
        yield diagnostic(ETraceReadDiagnostic.SEQUENCE_GAP);
      }
      sequence = Math.max(sequence, record.sequence);
      if (finished) {
        yield diagnostic(ETraceReadDiagnostic.AFTER_TERMINAL);
      }
      if (record.type === EAgentEventType.RUN_STARTED) {
        if (started || records !== 1) {
          yield diagnostic(ETraceReadDiagnostic.OUT_OF_ORDER);
        }
        started = true;
      }
      if (record.type === EAgentEventType.RUN_FINISHED) {
        finished = true;
      }
    }
    yield { type: ETraceReadItemType.RECORD, line, record };
  }
  signal?.throwIfAborted();
  if (!header) {
    yield diagnostic(ETraceReadDiagnostic.MISSING_HEADER);
  }
  if (!started) {
    yield diagnostic(ETraceReadDiagnostic.MISSING_RUN_STARTED);
  }
  if (!finished) {
    yield diagnostic(ETraceReadDiagnostic.MISSING_RUN_FINISHED);
  }
  if (!footer) {
    yield diagnostic(ETraceReadDiagnostic.MISSING_FOOTER);
  }
}
