import type { ToolExecutionContext } from './definition.js';
import type { ToolRegistry } from './registry.js';
import { ToolErrorCode, type ToolResult } from './result.js';

const DEFAULT_TIMEOUT_MS = 10_000; // 默认超时时间为 10 秒
const MAX_TIMEOUT_MS = 2_147_483_647; // 最大超时时间为 2,147,483,647 毫秒

const validateTimeoutMs = function (timeoutMs: number) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs 必须是一个介于 1 和 ${MAX_TIMEOUT_MS} 之间的整数`,
    );
  }
};

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS, // 默认超时时间为 10 秒
  ) {
    validateTimeoutMs(timeoutMs);
  }

  async execute(
    name: string,
    rawArguments: unknown,
    context: ToolExecutionContext,
    options?: { timeoutMs?: number },
  ): Promise<ToolResult> {
    const tool = this.registry.get(name);

    if (!tool) {
      return {
        success: false,
        error: {
          code: ToolErrorCode.UNKNOWN_TOOL,
          message: `工具 "${name}" 未注册`,
        },
      };
    }

    if (context.signal.aborted) {
      return {
        success: false,
        error: {
          code: ToolErrorCode.CANCELLED,
          message: '工具调用已取消',
        },
      };
    }

    const controller = new AbortController();
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    validateTimeoutMs(timeoutMs);

    let resolveStopRequest: (result: ToolResult) => void;
    // 超时、取消信号时都需要取消工具调用
    const stopRequest = (
      code: ToolErrorCode.TIMEOUT | ToolErrorCode.CANCELLED,
    ) => {
      resolveStopRequest({
        success: false,
        error: {
          code,
          message:
            code === ToolErrorCode.TIMEOUT
              ? `工具调用超时，超过 ${timeoutMs} 毫秒`
              : '工具调用已取消',
        },
      });
      controller.abort();
    };
    const onAbort = () => {
      stopRequest(ToolErrorCode.CANCELLED);
    };
    context.signal.addEventListener('abort', onAbort);

    const timmer = setTimeout(
      () => stopRequest(ToolErrorCode.TIMEOUT),
      timeoutMs,
    );
    const timeoutPromise = new Promise<ToolResult>((resolve) => {
      resolveStopRequest = resolve;
    });

    return Promise.race([
      timeoutPromise,
      tool.invoke(rawArguments, { signal: controller.signal }),
    ]).finally(() => {
      clearTimeout(timmer);
      context.signal.removeEventListener('abort', onAbort);
    });
  }
}
