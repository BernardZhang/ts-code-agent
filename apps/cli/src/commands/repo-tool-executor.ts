import {
  ToolExecutor,
  type ToolResult,
  type ToolRegistry,
} from '@ts-code-agent/core';
import { z } from 'zod';

const TRACE_PREFIX = '[tool]';
const MAX_TRACE_FIELD_LENGTH = 200;
const pathSchema = z.object({ path: z.string() });
enum ETraceStatus {
  STARTED = 'started',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
}

/** CLI 可选诊断：只记录工具名、请求路径与状态，不记录输入正文或工具输出。 */
export class RepoToolExecutor extends ToolExecutor {
  constructor(
    registry: ToolRegistry,
    private readonly traceEnabled: boolean,
  ) {
    super(registry);
  }

  override async execute(
    ...args: Parameters<ToolExecutor['execute']>
  ): Promise<ToolResult> {
    const [name, input] = args;
    const parsed = pathSchema.safeParse(input);
    const fields = {
      name: name.slice(0, MAX_TRACE_FIELD_LENGTH),
      ...(parsed.success
        ? { path: parsed.data.path.slice(0, MAX_TRACE_FIELD_LENGTH) }
        : {}),
    };
    const trace = (status: ETraceStatus, code?: string) => {
      if (this.traceEnabled) {
        process.stderr.write(
          `${TRACE_PREFIX} ${JSON.stringify({ ...fields, status, ...(code === undefined ? {} : { code }) })}\n`,
        );
      }
    };
    trace(ETraceStatus.STARTED);
    try {
      const result = await super.execute(...args);
      trace(
        result.success ? ETraceStatus.SUCCEEDED : ETraceStatus.FAILED,
        result.success ? undefined : result.error.code,
      );
      return result;
    } catch (error) {
      trace(ETraceStatus.FAILED);
      throw error;
    }
  }
}
