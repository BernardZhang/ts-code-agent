import { ragQuery } from './commands/rag-query.js';
import { loadEnv } from './load-env.js';
import {
  hybridSearchDemo,
  type HybridSearchDemoOptions,
} from './commands/hybrid-search.js';
import { readTrace, ETraceReadItemType } from '@ts-code-agent/adapters';
import { ModelErrorCode } from '@ts-code-agent/core';
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
import { ingestDemo } from './commands/ingest-demo.js';
import {
  createVectorStore,
  indexDemo,
  vectorSearchDemo,
} from './commands/vector-demo.js';
import { embedDemo } from './commands/embed-demo.js';
import {
  readEmbeddingConfig,
  type EmbeddingConfigOptions,
} from './embedding-config.js';
import { session } from './commands/session.js';

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
    .command('session')
    .description('交互式多轮只读仓库会话')
    .option('--trace', '保存脱敏运行追踪到工作区 .agent/traces', false)
    .option('--workspace <directory>', '只读工具工作区，默认当前目录')
    .option('--no-stream', '关闭流式输出，使用完整响应'),
).action(
  async (
    options: ConfigOptions & {
      workspace?: string;
      stream: boolean;
      trace: boolean;
    },
  ) => {
    const config = readConfig(options);
    // 会话自己区分“取消本轮”和“退出”；不能同时触发单次命令的取消器。
    process.removeListener('SIGINT', cancel);
    try {
      await session(config, options.workspace, options.stream, options.trace);
    } finally {
      process.once('SIGINT', cancel);
    }
  },
);

program
  .command('trace-read')
  .description('流式读取脱敏追踪并报告完整性诊断')
  .argument('<file>', 'JSONL 追踪文件')
  .action(async (file: string) => {
    for await (const item of readTrace(file, controller.signal)) {
      if (item.type === ETraceReadItemType.DIAGNOSTIC) {
        process.stderr.write(`[trace:${item.code}] line=${item.line}\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write(`${JSON.stringify(item.record)}\n`);
      }
    }
  });

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

program
  .command('ingest-demo')
  .description('离线导入 Markdown 或 TXT 并展示分块摘要')
  .argument('<path>', '文档的工作区相对路径')
  .requiredOption('--corpus-id <id>', '稳定的资料集标识')
  .option('--workspace <directory>', '工作区目录', '.')
  .action(
    async (
      sourcePath: string,
      options: { corpusId: string; workspace: string },
    ) => {
      await ingestDemo({
        rootPath: options.workspace,
        sourcePath,
        corpusId: options.corpusId,
        signal: controller.signal,
      });
    },
  );

program
  .command('embed-demo')
  .description('导入文档并调用 Ollama 生成向量摘要')
  .argument('<path>', '文档的工作区相对路径')
  .requiredOption('--corpus-id <id>', '稳定的资料集标识')
  .option('--workspace <directory>', '工作区目录', '.')
  .option('--base-url <url>', 'Ollama 地址')
  .option('--model <name>', 'Embedding 模型名称')
  .option('--dimensions <number>', '模型实际输出的预期向量维度')
  .option('--timeout-ms <ms>', '单批请求超时')
  .action(
    async (
      sourcePath: string,
      options: EmbeddingConfigOptions & {
        corpusId: string;
        workspace: string;
      },
    ) => {
      await embedDemo(
        {
          rootPath: options.workspace,
          sourcePath,
          corpusId: options.corpusId,
          signal: controller.signal,
        },
        readEmbeddingConfig(options),
      );
    },
  );

const configureVectorCommand = (command: Command) =>
  command
    .option('--base-url <url>', 'Ollama 地址')
    .option('--model <name>', 'Embedding 模型')
    .option('--dimensions <number>', '预期向量维度')
    .option('--timeout-ms <ms>', '模型请求超时');

configureVectorCommand(
  program.command('vector-init').description('显式创建 pgvector 扩展和 RAG 表'),
).action(async (options: EmbeddingConfigOptions) => {
  await createVectorStore(readEmbeddingConfig(options)).initialize(
    controller.signal,
  );
  process.stdout.write('向量数据库初始化完成。\n');
});

configureVectorCommand(
  program
    .command('index-demo')
    .description('向量化文档并事务替换数据库片段')
    .argument('<path>', '工作区相对路径')
    .requiredOption('--corpus-id <id>', '资料集标识')
    .option('--workspace <directory>', '工作区目录', '.'),
).action(
  async (
    sourcePath: string,
    options: EmbeddingConfigOptions & {
      corpusId: string;
      workspace: string;
    },
  ) => {
    await indexDemo(
      {
        rootPath: options.workspace,
        sourcePath,
        corpusId: options.corpusId,
        signal: controller.signal,
      },
      readEmbeddingConfig(options),
    );
  },
);

configureVectorCommand(
  program
    .command('vector-search')
    .description('在指定资料集和模型中查询最接近的五个片段')
    .argument('<query>', '查询文本')
    .requiredOption('--corpus-id <id>', '资料集标识'),
).action(
  async (
    query: string,
    options: EmbeddingConfigOptions & { corpusId: string },
  ) => {
    await vectorSearchDemo(
      query,
      options.corpusId,
      readEmbeddingConfig(options),
      controller.signal,
    );
  },
);

configureVectorCommand(
  program
    .command('hybrid-search')
    .description('关键词与向量召回，使用等权 RRF 融合')
    .argument('<query>', '语义查询文本')
    .requiredOption('--corpus-id <id>', '资料集标识')
    .option('--keywords <terms...>', '显式字面关键词，默认按查询空白拆分')
    .option('--source-path <path>', '精确来源路径过滤')
    .option('--document-id <id>', '精确文档 ID 过滤'),
).action(
  async (
    query: string,
    options: EmbeddingConfigOptions & HybridSearchDemoOptions,
  ) => {
    await hybridSearchDemo(
      query,
      options,
      readEmbeddingConfig(options),
      controller.signal,
    );
  },
);

configure(
  program
    .command('rag-query')
    .description('检索资料，构建预算内证据并生成带引用的回答')
    .argument('<question>', '问题')
    .requiredOption('--corpus-id <id>', '资料集标识')
    .option('--keywords <terms...>', '显式关键词')
    .option('--source-path <path>', '精确来源路径过滤')
    .option('--document-id <id>', '精确文档 ID 过滤')
    .option('--embedding-model <name>', 'Embedding 模型，独立于回答模型')
    .option('--embedding-dimensions <number>', '预期向量维度'),
).action(
  async (
    question: string,
    options: ConfigOptions &
      HybridSearchDemoOptions & {
        embeddingModel?: string;
        embeddingDimensions?: string;
      },
  ) => {
    await ragQuery(
      question,
      options,
      readConfig(options),
      readEmbeddingConfig({
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.embeddingModel ? { model: options.embeddingModel } : {}),
        ...(options.embeddingDimensions
          ? { dimensions: options.embeddingDimensions }
          : {}),
      }),
      controller.signal,
    );
  },
);

try {
  loadEnv();
  await program.parseAsync();
  if (controller.signal.aborted) {
    process.exitCode = 130;
  }
} catch (error) {
  if (
    controller.signal.aborted ||
    (error instanceof ModelError && error.code === ModelErrorCode.CANCELLED)
  ) {
    process.stderr.write('请求已取消。\n');
    process.exitCode = 130;
  } else if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    const message =
      error instanceof ZodError
        ? '配置不合法，请检查模型、地址、数字参数以及 think 的 true/false 值。'
        : error instanceof ModelError || error instanceof ContextError
          ? `[${error.code}] ${error.message}`
          : '发生未预期错误。';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', cancel);
}
