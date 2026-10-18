import { Command, CommanderError } from 'commander';
import { ModelError } from '@ts-code-agent/core';
import { ZodError } from 'zod';
import { readConfig, type ConfigOptions } from './config.js';
import { chat } from './commands/chat.js';
import { structuredDemo } from './commands/structured-demo.js';
import { toolsDemo } from './commands/tools-demo.js';

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);

const program = new Command()
  .name('ts-code-agent')
  .description('Day 1：本地 Ollama 模型实验')
  .exitOverride();
const configure = (command: Command) =>
  command
    .option('--base-url <url>', 'Ollama 地址')
    .option('--model <name>', '模型名称')
    .option('--context-length <tokens>', '上下文长度')
    .option('--timeout-ms <ms>', '请求超时')
    .option('--think <boolean>', 'true 或 false');

configure(
  program
    .command('chat')
    .argument('<prompt>', '提示词')
    .option('--no-stream', '关闭流式输出'),
).action(
  async (prompt: string, options: ConfigOptions & { stream: boolean }) => {
    await chat(prompt, readConfig(options), options.stream, controller.signal);
  },
);
configure(program.command('structured-demo')).action(
  async (options: ConfigOptions) => {
    await structuredDemo(readConfig(options), controller.signal);
  },
);
configure(program.command('tools-demo').argument('<prompt>', '提示词')).action(
  async (prompt: string, options: ConfigOptions) => {
    await toolsDemo(prompt, readConfig(options), controller.signal);
  },
);

try {
  await program.parseAsync();
  if (controller.signal.aborted) process.exitCode = 130;
} catch (error) {
  if (
    controller.signal.aborted ||
    (error instanceof ModelError && error.code === 'cancelled')
  ) {
    process.stderr.write('请求已取消。\n');
    process.exitCode = 130;
  } else if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    const message =
      error instanceof ZodError
        ? '配置不合法，请检查地址、数字参数以及 think 的 true/false 值。'
        : error instanceof ModelError
          ? `[${error.code}] ${error.message}`
          : '发生未预期错误。';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', cancel);
}
