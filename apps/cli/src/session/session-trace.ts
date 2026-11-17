import { randomUUID } from 'node:crypto';
import {
  EAgentEventType,
  TraceCollector,
  type AgentRunner,
  type AgentRunOptions,
  type AgentResult,
} from '@ts-code-agent/core';
import {
  FileTraceStore,
  ETraceAdmission,
  ETraceWriteStatus,
  ETraceWriteError,
} from '@ts-code-agent/adapters';

const CLOSE_TIMEOUT_MS = 5000;
type Runner = Pick<AgentRunner, 'run'>;
type TraceStore = Pick<FileTraceStore, 'createWriter' | 'close'>;
type Notify = (message: string) => void;

/** Decoration keeps tracing failures separate from Agent results and session history. */
export class TracedAgentRunner implements Runner {
  constructor(
    private readonly runner: Runner,
    private readonly store: TraceStore,
    private readonly notify: Notify,
  ) {}

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const runId = options.runId ?? randomUUID();
    let trace: Awaited<ReturnType<TraceStore['createWriter']>> | undefined;
    let warned = false;
    const warn = (message: string) => {
      if (!warned) {
        warned = true;
        this.display(message);
      }
    };
    try {
      trace = await this.store.createWriter({
        runId,
        hooks: {
          onError: (report) => {
            if (report.errorCode === ETraceWriteError.CLOSE_FAILED) {
              warn(
                report.dropped === 0
                  ? '追踪记录已写入，但文件关闭失败，资源释放未确认。'
                  : '已接收的追踪记录已写入，但存在丢弃记录，且文件关闭失败。',
              );
            } else {
              warn('追踪写入失败，Agent 将继续运行，文件可能不完整。');
            }
          },
        },
      });
    } catch {
      warn('本轮追踪不可用，Agent 将继续运行。');
    }
    const collector = trace ? new TraceCollector(runId) : undefined;
    try {
      return await this.runner.run({
        ...options,
        runId,
        onEvent: (event) => {
          // Capture terminal events even when the console has already requested exit.
          if (trace && collector) {
            try {
              const record = collector.record(event);
              if (record) {
                const admission = trace.writer.enqueue(record);
                if (admission !== ETraceAdmission.ACCEPTED) {
                  warn(
                    '追踪记录未完整保存（容量或写入限制），Agent 将继续运行。',
                  );
                }
              }
            } catch {
              warn('追踪记录失败，Agent 将继续运行。');
            }
          }
          if (event.type === EAgentEventType.TOOL_CALL_STARTED) {
            this.display(`工具开始：${event.toolName}`);
          }
          if (event.type === EAgentEventType.TOOL_CALL_FINISHED) {
            this.display(
              `工具结束：${event.toolName}（${event.success ? '成功' : '失败'}）`,
            );
          }
          options.onEvent?.(event);
        },
      });
    } finally {
      if (trace) {
        try {
          const report = await trace.writer.close();
          if (report.status === ETraceWriteStatus.TIMED_OUT) {
            this.display('追踪关闭等待超时；后台仍在收尾，进程退出可能延迟。');
          } else if (report.status === ETraceWriteStatus.FAILED) {
            warn('追踪收尾失败，文件可能不完整。');
          }
          this.display(
            `追踪文件：${trace.filePath}（写入 ${report.written}，丢弃 ${report.dropped}）`,
          );
        } catch {
          warn('追踪收尾失败，Agent 结果不受影响。');
        }
      }
    }
  }
  private display(message: string): void {
    try {
      this.notify(message);
    } catch {
      /* Display cannot fail the Agent. */
    }
  }
}

export async function createSessionTracing(
  runner: Runner,
  directory: string,
  notify: Notify,
): Promise<{ runner: Runner; close: () => Promise<void> }> {
  const display = (message: string) => {
    try {
      notify(message);
    } catch {
      /* Diagnostic only. */
    }
  };
  let store: FileTraceStore;
  try {
    store = await FileTraceStore.open({ directory });
  } catch {
    display('追踪不可用，Agent 将继续运行。');
    return { runner, close: async () => {} };
  }
  let closePromise: Promise<void> | undefined;
  return {
    runner: new TracedAgentRunner(runner, store, display),
    close: () => {
      closePromise ??= new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          display('追踪目录关闭等待超时；后台收尾期间继续持有目录锁。');
          resolve();
        }, CLOSE_TIMEOUT_MS);
        void store.close().then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          () => {
            clearTimeout(timer);
            display('追踪目录收尾失败，请检查锁与文件状态。');
            resolve();
          },
        );
      });
      return closePromise;
    },
  };
}
