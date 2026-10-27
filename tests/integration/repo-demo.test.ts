import { execFile, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EContextErrorCode, EMessageRole } from '@ts-code-agent/core';

const EModel = {
  NORMAL: 'repo-test',
  REPEAT: 'repeat-test',
  HANG: 'hang-test',
  OUTSIDE: 'outside-test',
} as const;
const TOOL = {
  LIST: 'list_directory',
  READ: 'read_file',
  SEARCH: 'search_code',
  GIT: 'git_status',
} as const;
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      tool_name: z.string().optional(),
    }),
  ),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
});
type Request = z.infer<typeof requestSchema>;
const requests: Request[] = [];
const events = new EventEmitter();
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  const input = requestSchema.parse(JSON.parse(body));
  requests.push(input);
  if (input.model === EModel.HANG) {
    events.emit('hanging');
    return;
  }
  const results = input.messages.filter(
    (message) => message.role === EMessageRole.TOOL,
  );
  const calls =
    input.model === EModel.REPEAT
      ? [{ function: { name: TOOL.LIST, arguments: { path: '.' } } }]
      : input.model === EModel.OUTSIDE
        ? [
            {
              function: {
                name: TOOL.READ,
                arguments: { path: '../outside.txt' },
              },
            },
          ]
        : [
            { function: { name: TOOL.LIST, arguments: { path: '.' } } },
            { function: { name: TOOL.READ, arguments: { path: 'main.ts' } } },
            {
              function: {
                name: TOOL.SEARCH,
                arguments: { path: '.', content: 'hello' },
              },
            },
            { function: { name: TOOL.GIT, arguments: {} } },
          ];
  response.end(
    JSON.stringify({
      done: true,
      message:
        results.length && input.model !== EModel.REPEAT
          ? { role: EMessageRole.ASSISTANT, content: '仓库分析回答' }
          : { role: EMessageRole.ASSISTANT, content: '', tool_calls: calls },
    }),
  );
});
let temporaryPath: string;
let rootPath: string;
let url: string;
beforeAll(async () => {
  temporaryPath = await mkdtemp(path.join(os.tmpdir(), 'repo-cli-'));
  rootPath = path.join(temporaryPath, 'project');
  await promisify(execFile)('git', ['init', '--quiet', rootPath]);
  await writeFile(path.join(rootPath, 'main.ts'), 'export const hello = 1;');
  await writeFile(path.join(temporaryPath, 'outside.txt'), 'PRIVATE_SENTINEL');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing address');
  url = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  requests.length = 0;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(temporaryPath, { recursive: true, force: true });
});
function run(extra: string[] = []) {
  const child = spawn(
    process.execPath,
    [
      'apps/cli/dist/main.js',
      'repo-demo',
      '分析项目',
      '--workspace',
      rootPath,
      '--base-url',
      url,
      '--model',
      EModel.NORMAL,
      ...extra,
    ],
    { env: { ...process.env, AGENT_TIMEOUT_MS: '5000' } },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const result = once(child, 'close').then(([code]) => ({
    code,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  }));
  return { child, result };
}
describe('repo-demo CLI', () => {
  it('注册四个工具，实际执行并将完整结果回传模型', async () => {
    const output = await run().result;
    expect(output.code).toBe(0);
    expect(output.stdout).toBe('仓库分析回答\n');
    expect(output.stderr).toContain('工具调用 4 次');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools.map((tool) => tool.function.name).sort()).toEqual(
      Object.values(TOOL).sort(),
    );
    const messages = requests[1]?.messages.filter(
      (message) => message.role === EMessageRole.TOOL,
    );
    expect(messages).toHaveLength(4);
    const schema = z.object({ success: z.literal(true), output: z.unknown() });
    const results = messages?.map((message) =>
      schema.parse(JSON.parse(message.content)),
    );
    expect(results?.[1]?.output).toMatchObject({
      path: 'main.ts',
      content: 'export const hello = 1;',
    });
    expect(results?.[2]?.output).toMatchObject({
      matches: [{ path: 'main.ts', line: 1, column: 14 }],
    });
    expect(results?.[3]?.output).toMatchObject({ clean: false });
    expect(requests[0]?.messages[0]?.content).toContain('工具结果');
    expect(requests[0]?.messages[0]?.content).toContain('"path":"."');
    expect(output.stderr).not.toContain('[tool]');
  });
  it('可选诊断显示工具路径与结果，不输出文件或搜索正文', async () => {
    const output = await run(['--trace-tools']).result;
    expect(output.code).toBe(0);
    expect(output.stderr).toContain('[tool]');
    expect(output.stderr).toContain('"path":"."');
    expect(output.stderr).toContain('"path":"main.ts"');
    expect(output.stderr).toContain('"status":"succeeded"');
    expect(output.stderr).not.toContain('export const hello = 1;');
    expect(output.stderr).not.toContain('"content":');
    expect(output.stdout).toBe('仓库分析回答\n');
  });
  it('诊断记录越界失败的工具名、路径及错误码', async () => {
    const output = await run(['--trace-tools', '--model', EModel.OUTSIDE])
      .result;
    expect(output.stderr).toContain('"name":"read_file"');
    expect(output.stderr).toContain('"path":"../outside.txt"');
    expect(output.stderr).toContain('"status":"failed"');
    expect(output.stderr).toContain('"code":"execution_failed"');
    expect(output.stderr).not.toContain('PRIVATE_SENTINEL');
  });
  it('路径越界作为工具失败回传，不读取外部文件', async () => {
    const output = await run(['--model', EModel.OUTSIDE]).result;
    expect(output.code).toBe(0);
    const message = requests[1]?.messages.find(
      (item) => item.role === EMessageRole.TOOL,
    );
    expect(message).toBeDefined();
    expect(JSON.parse(message?.content ?? '')).toMatchObject({
      success: false,
    });
    expect(message?.content).not.toContain('PRIVATE_SENTINEL');
  });
  it('工作区不存在时请求模型前失败', async () => {
    const output = await run(['--workspace', path.join(rootPath, 'missing')])
      .result;
    expect(output.code).toBe(1);
    expect(output.stderr).toContain('工作区');
    expect(requests).toHaveLength(0);
  });
  it('上下文预算不足时不请求模型', async () => {
    const output = await run(['--context-length', '256']).result;
    expect(output.code).toBe(1);
    expect(output.stderr).toContain(EContextErrorCode.BUDGET_EXCEEDED);
    expect(requests).toHaveLength(0);
  });
  it('达到步数上限非零退出，不生成额外总结请求', async () => {
    const output = await run([
      '--model',
      EModel.REPEAT,
      '--context-length',
      '32768',
    ]).result;
    expect(output.code).toBe(1);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('最大模型请求次数');
    expect(requests).toHaveLength(10);
  });
  it('活动请求支持 SIGINT，退出 130', async () => {
    const started = once(events, 'hanging');
    const { child, result } = run(['--model', EModel.HANG]);
    await started;
    child.kill('SIGINT');
    expect((await result).code).toBe(130);
  });
});
