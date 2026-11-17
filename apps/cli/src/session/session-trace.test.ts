import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  AgentRunner,
  EAgentStatus,
  EAgentEventType,
  ToolExecutor,
  ToolRegistry,
} from '@ts-code-agent/core';
import {
  BatchTraceWriter,
  ETraceWriteStatus,
  FileTraceStore,
} from '@ts-code-agent/adapters';
import { createSessionTracing, TracedAgentRunner } from './session-trace.js';

const runOptions = { request: { model: 'fake', messages: [] }, maxSteps: 1 };
function runner() {
  return new AgentRunner(
    {
      capabilities: { structuredOutput: false },
      stream: vi.fn(),
      generate: async () => ({ text: 'PRIVATE MODEL CONTENT', usage: {} }),
    },
    new ToolExecutor(new ToolRegistry()),
  );
}
it('初始化失败不影响Agent结果，提示不泄漏底层错误', async () => {
  const store = {
    createWriter: vi.fn().mockRejectedValue(new Error('PRIVATE')),
    close: vi.fn(),
  };
  const notify = vi.fn();
  const traced = new TracedAgentRunner(runner(), store, notify);
  expect((await traced.run(runOptions)).status).toBe(EAgentStatus.COMPLETE);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(notify.mock.calls)).not.toContain('PRIVATE');
});
it('后台写入失败不改变Agent成功结果，关闭仍被调用', async () => {
  const close = vi.fn(async () => {});
  const writer = new BatchTraceWriter({
    write: async () => {
      throw new Error('disk full');
    },
    close,
  });
  const store = {
    createWriter: vi.fn().mockResolvedValue({ writer, filePath: 'test.jsonl' }),
    close: vi.fn(),
  };
  const traced = new TracedAgentRunner(runner(), store, () => {});
  expect((await traced.run(runOptions)).status).toBe(EAgentStatus.COMPLETE);
  expect((await writer.settled).status).toBe(ETraceWriteStatus.FAILED);
  expect(close).toHaveBeenCalledTimes(1);
});
it('真实Store多轮独立文件、共享runId、记录终态且正文脱敏', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-trace-'));
  const notify = vi.fn();
  const tracing = await createSessionTracing(runner(), root, notify);
  try {
    const events: string[] = [];
    await tracing.runner.run({
      ...runOptions,
      onEvent: (event) => {
        events.push(event.runId);
      },
    });
    await tracing.runner.run(runOptions);
    const names = (await readdir(root)).filter((name) =>
      name.endsWith('.jsonl'),
    );
    expect(names).toHaveLength(2);
    const files = await Promise.all(
      names.map((name) => readFile(join(root, name), 'utf8')),
    );
    expect(files.join('')).not.toContain('PRIVATE MODEL CONTENT');
    expect(
      files.every((file) => file.includes(EAgentEventType.RUN_FINISHED)),
    ).toBe(true);
    expect(new Set(events).size).toBe(1);
    expect(files.some((file) => file.includes(events[0] ?? 'missing'))).toBe(
      true,
    );
  } finally {
    await tracing.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('模型异常仍保存失败终态，并原样向会话传播', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-trace-'));
  const store = await FileTraceStore.open({ directory: root });
  const error = new Error('PRIVATE FAILURE');
  const failing = new AgentRunner(
    {
      capabilities: { structuredOutput: false },
      stream: vi.fn(),
      generate: async () => {
        throw error;
      },
    },
    new ToolExecutor(new ToolRegistry()),
  );
  try {
    await expect(
      new TracedAgentRunner(failing, store, () => {}).run(runOptions),
    ).rejects.toBe(error);
    const file = (await readdir(root)).find((name) => name.endsWith('.jsonl'));
    const content = await readFile(join(root, file ?? ''), 'utf8');
    expect(content).toContain(EAgentEventType.RUN_FINISHED);
    expect(content).not.toContain(error.message);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('展示回调抛错也不影响Agent与清理', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-trace-'));
  const tracing = await createSessionTracing(runner(), root, () => {
    throw new Error('display');
  });
  try {
    expect((await tracing.runner.run(runOptions)).status).toBe(
      EAgentStatus.COMPLETE,
    );
  } finally {
    await tracing.close();
    await rm(root, { recursive: true, force: true });
  }
});
