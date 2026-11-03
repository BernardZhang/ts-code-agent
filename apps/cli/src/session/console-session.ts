import { EAgentEventType, ModelErrorCode } from '@ts-code-agent/core';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { EAgentStatus, ContextError, ModelError } from '@ts-code-agent/core';
import { AgentSession, ESessionState } from './agent-session.js';

export enum ESessionCommand {
  EXIT = '/exit',
  RESET = '/reset',
  MULTILINE = '/multiline',
  SEND = '/send',
  CANCEL = '/cancel',
}

enum EInputMode {
  SINGLE_LINE = 'single_line',
  MULTILINE = 'multiline',
}

export interface ConsoleSessionOptions {
  input?: Readable;
  output?: Writable;
  error?: Writable;
  terminal?: boolean;
}

const PROMPT = '> ';
const MULTILINE_PROMPT = '… ';
const ABORT_ERROR_NAME = 'AbortError';

/** 终端事件协调；历史和任务状态由 AgentSession 负责。 */
export class ConsoleSession {
  constructor(
    private readonly session: AgentSession,
    private readonly options: ConsoleSessionOptions = {},
  ) {}

  async run(): Promise<void> {
    if (this.session.state !== ESessionState.IDLE) {
      throw new Error('终端会话必须从空闲状态启动。');
    }
    const input = this.options.input ?? process.stdin;
    const output = this.options.output ?? process.stdout;
    const error = this.options.error ?? process.stderr;
    const terminal =
      this.options.terminal ??
      (input === process.stdin && process.stdin.isTTY === true);
    const readline = createInterface({
      input,
      output,
      terminal,
      prompt: PROMPT,
    });
    let closing = false;
    let pending: Promise<void> | undefined;
    let inputMode = EInputMode.SINGLE_LINE;
    let inputLines: string[] = [];
    let discardingCurrentLine = false;

    let notifyClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });

    const prompt = () => {
      if (!closing) {
        readline.setPrompt(
          inputMode === EInputMode.MULTILINE ? MULTILINE_PROMPT : PROMPT,
        );
        readline.prompt();
      }
    };
    // readline.close() 还会触发 close；先置位，保证退出逻辑幂等。
    const close = () => {
      if (closing) {
        return;
      }
      closing = true;
      inputLines = [];
      this.session.close();
      readline.close();
      // close 只解除 readline；由本会话拥有的 stdin 管道也需释放，才能退出进程。
      if (input === process.stdin) {
        input.destroy();
      }
      notifyClosed();
    };

    const execute = async (text: string) => {
      let hasStreamedText = false;
      let outputEndsWithNewline = true;
      const writeDelta = (text: string) => {
        if (!text) {
          return;
        }

        hasStreamedText = true;
        output.write(text);
        outputEndsWithNewline = text.endsWith('\n');
      };
      const finishOutputLine = () => {
        // 按本轮状态补换行
        if (!outputEndsWithNewline) {
          output.write('\n');
          outputEndsWithNewline = true;
        }
      };

      try {
        const result = await this.session.submit(text, (event) => {
          if (closing) {
            return;
          }

          if (event.type === EAgentEventType.TEXT_DELTA) {
            writeDelta(event.text);
          }
        });

        if (closing) {
          return;
        }

        if (result.status === EAgentStatus.COMPLETE) {
          if (this.session.stream) {
            finishOutputLine();
          } else {
            output.write(`${result.result.text}\n`);
          }
        } else {
          finishOutputLine();
          if (hasStreamedText) {
            error.write('以上输出不完整。\n');
          }
          error.write(
            '已达到步数上限，当前任务尚未完成；完整调用历史已保存，可继续输入。\n',
          );
        }
      } catch (cause) {
        if (closing) {
          return;
        }

        finishOutputLine();

        if (
          (cause instanceof Error && cause.name === ABORT_ERROR_NAME) ||
          (cause instanceof ModelError &&
            cause.code === ModelErrorCode.CANCELLED)
        ) {
          error.write(
            hasStreamedText
              ? '当前任务已取消；以上输出不完整，本轮对话未保存，已执行的工具操作不会回滚。\n'
              : '当前任务已取消；本轮对话未保存，已执行的工具操作不会回滚。\n',
          );
        } else {
          const message =
            cause instanceof Error ? cause.message : '发生未知错误。';
          const code =
            cause instanceof ModelError || cause instanceof ContextError
              ? `[${cause.code}] `
              : '';
          error.write(`${code}${message}\n`);
          error.write(
            hasStreamedText
              ? '以上输出不完整，本轮对话未保存，已执行的工具操作不会回滚。\n'
              : '本轮对话未保存，已执行的工具操作不会回滚。\n',
          );
        }
      } finally {
        prompt();
      }
    };
    const discardDraft = () => {
      inputLines = [];
      inputMode = EInputMode.SINGLE_LINE;
      output.write('多行草稿已放弃。\n');
      prompt();
    };
    const onLine = (text: string) => {
      if (closing || discardingCurrentLine) {
        return;
      }
      // 先收集多行，保留空行和缩进；仅独占整行的 send/cancel 是控制命令。
      if (inputMode === EInputMode.MULTILINE) {
        if (text === ESessionCommand.CANCEL) {
          discardDraft();
        } else if (text === ESessionCommand.SEND) {
          const message = inputLines.join('\n');
          if (!message.trim()) {
            error.write('输入不能为空，请继续输入或使用 /cancel 放弃。\n');
            prompt();
            return;
          }
          inputLines = [];
          inputMode = EInputMode.SINGLE_LINE;
          pending = execute(message);
        } else {
          inputLines.push(text);
          prompt();
        }
        return;
      }
      const command = text.trim();
      if (!command) {
        if (this.session.state === ESessionState.IDLE) {
          prompt();
        }
        return;
      }
      if (command === ESessionCommand.EXIT) {
        close();
        return;
      }
      if (this.session.state === ESessionState.RUNNING) {
        error.write('当前任务尚未结束；本次输入已丢弃。\n');
        return;
      }
      if (command === ESessionCommand.RESET) {
        this.session.reset();
        output.write('对话历史已重置。\n');
        prompt();
        return;
      }
      if (command === ESessionCommand.MULTILINE) {
        inputMode = EInputMode.MULTILINE;
        inputLines = [];
        output.write('进入多行输入；单独输入 /send 提交，/cancel 放弃。\n');
        prompt();
        return;
      }
      if (
        command === ESessionCommand.SEND ||
        command === ESessionCommand.CANCEL
      ) {
        error.write('当前不在多行输入模式，请先使用 /multiline。\n');
        prompt();
        return;
      }
      // 事件系统不会等待异步监听器；保存 Promise，退出时显式等待收尾。
      pending = execute(text);
    };
    const onInterrupt = () => {
      if (closing) {
        return;
      }
      output.write('\n');
      if (inputMode === EInputMode.MULTILINE) {
        // 用公开 API 结束并忽略当前行；TTY 与管道的写入方式不同。
        discardingCurrentLine = true;
        try {
          if (terminal) {
            readline.write(null, { name: 'return' });
          } else {
            readline.write('\n');
          }
        } finally {
          discardingCurrentLine = false;
        }
        discardDraft();
      } else if (this.session.state === ESessionState.RUNNING) {
        this.session.cancelCurrent();
      } else {
        close();
      }
    };
    const onError = (cause: Error) => {
      error.write(`终端输入失败：${cause.message}\n`);
      close();
    };

    readline.on('line', onLine);
    readline.on('SIGINT', onInterrupt);
    readline.on('close', close);
    readline.on('error', onError);
    // TTY 的 Ctrl+C 由 readline 处理；kill -SIGINT 等进程信号走同一入口。
    const ownsProcessInput = input === process.stdin;
    if (ownsProcessInput) {
      process.on('SIGINT', onInterrupt);
    }
    try {
      prompt();
      await closed;
      await pending;
    } finally {
      close();
      readline.removeListener('line', onLine);
      readline.removeListener('SIGINT', onInterrupt);
      readline.removeListener('close', close);
      readline.removeListener('error', onError);
      if (ownsProcessInput) {
        process.removeListener('SIGINT', onInterrupt);
      }
    }
  }
}
