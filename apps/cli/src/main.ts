import { Command, CommanderError } from 'commander';
import { ContextError, ModelError } from '@ts-code-agent/core';
import { ZodError } from 'zod';
import { readConfig, type ConfigOptions } from './config.js';
import { chat } from './commands/chat.js';
import { structuredDemo } from './commands/structured-demo.js';
import { toolsDemo } from './commands/tools-demo.js';
import { agentDemo } from './commands/agent-demo.js';
import { planDemo } from './commands/plan-demo.js';
import { contextDemo } from './commands/context-demo.js';
import { repoDemo } from './commands/repo-demo.js';

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);

const program = new Command()
  .name('ts-code-agent')
  .description('本地模型与只读仓库分析 CLI')
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
program
  .command('context-demo')
  .description('离线演示计划更新与上下文裁剪（模拟 token 成本）')
  .action(() => contextDemo());

configure(program.command('structured-demo')).action(
  async (options: ConfigOptions) => {
    await structuredDemo(readConfig(options), controller.signal);
  },
);
configure(
  program
    .command('plan-demo')
    .argument('<prompt>', '提示词')
    .action(async (prompt: string, options: ConfigOptions) => {
      await planDemo(prompt, readConfig(options), controller.signal);
    }),
);
configure(program.command('tools-demo').argument('<prompt>', '提示词')).action(
  async (prompt: string, options: ConfigOptions) => {
    await toolsDemo(prompt, readConfig(options), controller.signal);
  },
);
configure(
  program
    .command('agent-demo')
    .argument('<prompt>', '提示词')
    .action(async (prompt: string, options: ConfigOptions) => {
      await agentDemo(prompt, readConfig(options), controller.signal);
    }),
);

configure(
  program
    .command('repo-demo')
    .description('通过四个只读工具分析工作区（不修改代码）')
    .argument('<prompt>', '仓库分析任务')
    .option('--workspace <directory>', '工作区目录', '.')
    .option('--trace-tools', '向 stderr 输出工具名、路径与执行状态', false),
).action(
  async (
    prompt: string,
    options: ConfigOptions & { workspace: string; traceTools: boolean },
  ) => {
    await repoDemo(
      prompt,
      options.workspace,
      readConfig(options),
      controller.signal,
      options.traceTools,
    );
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
        : error instanceof ModelError || error instanceof ContextError
          ? `[${error.code}] ${error.message}`
          : '发生未预期错误。';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', cancel);
}
