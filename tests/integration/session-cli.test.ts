import { ModelErrorCode } from '@ts-code-agent/core';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
// 模拟 Ollama 的外部工具协议名称，集中定义。
const LIST_DIRECTORY_TOOL_NAME = 'list_directory';
const READ_FILE_TOOL_NAME = 'read_file';
const SEARCH_CODE_TOOL_NAME = 'search_code';
const GIT_STATUS_TOOL_NAME = 'git_status';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EMessageRole } from '@ts-code-agent/core';

const requestSchema = z.object({
  stream: z.boolean(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.string(),
      tool_name: z.string().optional(),
    }),
  ),
  tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
});
type RequestBody = z.infer<typeof requestSchema>;
let temporaryPath = '';
let workspace = '';
const FIXTURE_CONTENT = 'session repository evidence';
const TOOL_REQUEST = '检查仓库';
const OUTSIDE_REQUEST = '尝试越界';
const MULTILINE_QUERY = 'evidence\nnext line';
const MULTILINE_REQUEST = `搜索完整文本：\n${MULTILINE_QUERY}`;
const FOLLOW_UP_REQUEST = '读取刚才文件';
const FOLLOW_UP_ANSWER = '已根据历史重新读取文件';
const requests: RequestBody[] = [];
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
  }
  const input = requestSchema.parse(JSON.parse(body));
  requests.push(input);
  const last = input.messages.at(-1)?.content;
  if (last === FOLLOW_UP_REQUEST) {
    const previousRead = input.messages.find(
      (message) => message.tool_name === READ_FILE_TOOL_NAME,
    );
    const previous = z
      .object({ output: z.object({ path: z.string() }) })
      .parse(JSON.parse(previousRead?.content ?? ''));
    response.end(
      JSON.stringify({
        done: true,
        message: {
          role: EMessageRole.ASSISTANT,
          content: '',
          tool_calls: [
            {
              function: {
                name: READ_FILE_TOOL_NAME,
                arguments: { path: previous.output.path },
              },
            },
          ],
        },
      }),
    );
    return;
  }
  if (
    input.messages.at(-1)?.role === EMessageRole.TOOL &&
    input.messages
      .filter((message) => message.role === EMessageRole.USER)
      .at(-1)?.content === FOLLOW_UP_REQUEST
  ) {
    response.end(
      JSON.stringify({
        done: true,
        message: { role: EMessageRole.ASSISTANT, content: FOLLOW_UP_ANSWER },
      }),
    );
    return;
  }
  if (last === MULTILINE_REQUEST) {
    response.end(
      JSON.stringify({
        done: true,
        message: {
          role: EMessageRole.ASSISTANT,
          content: '',
          tool_calls: [
            {
              function: {
                name: SEARCH_CODE_TOOL_NAME,
                arguments: { path: '.', content: MULTILINE_QUERY },
              },
            },
          ],
        },
      }),
    );
    return;
  }
  if (last === TOOL_REQUEST || last === OUTSIDE_REQUEST) {
    const calls =
      last === OUTSIDE_REQUEST
        ? [
            {
              function: {
                name: READ_FILE_TOOL_NAME,
                arguments: { path: '../outside.txt' },
              },
            },
          ]
        : [
            {
              function: {
                name: LIST_DIRECTORY_TOOL_NAME,
                arguments: { path: '.' },
              },
            },
            {
              function: {
                name: READ_FILE_TOOL_NAME,
                arguments: { path: 'fixture.txt' },
              },
            },
            {
              function: {
                name: SEARCH_CODE_TOOL_NAME,
                arguments: { path: '.', content: 'evidence' },
              },
            },
            { function: { name: GIT_STATUS_TOOL_NAME, arguments: {} } },
          ];
    response.end(
      JSON.stringify({
        done: true,
        message: {
          role: EMessageRole.ASSISTANT,
          content: '',
          tool_calls: calls,
        },
      }),
    );
    return;
  }
  if (last === '等待取消') {
    return;
  }
  if (last === '模拟错误') {
    response.writeHead(503).end();
    return;
  }
  response.end(
    JSON.stringify({
      done: true,
      message: {
        role: 'assistant',
        content:
          input.messages.at(-1)?.role === EMessageRole.TOOL
            ? JSON.stringify(
                input.messages.filter(
                  (message) => message.role === EMessageRole.TOOL,
                ),
              )
            : `回答：${last}`,
      },
    }),
  );
});
let url = '';
beforeAll(async () => {
  temporaryPath = await mkdtemp(path.join(os.tmpdir(), 'session-cli-'));
  workspace = path.join(temporaryPath, 'project');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'fixture.txt'), FIXTURE_CONTENT);
  await writeFile(path.join(temporaryPath, 'outside.txt'), 'outside secret');
  await promisify(execFile)('git', ['init', '--quiet', workspace]);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('未获取服务地址');
  }
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await rm(temporaryPath, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
function start(targetWorkspace = workspace, stream = true) {
  const child = spawn(
    process.execPath,
    [
      'apps/cli/dist/main.js',
      'session',
      '--base-url',
      url,
      '--model',
      'session-test',
      '--workspace',
      targetWorkspace,
      ...(stream ? [] : ['--no-stream']),
    ],
    {
      env: { ...process.env, AGENT_TIMEOUT_MS: '3000' },
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = once(child, 'close').then(([code]) => ({
    code,
    stdout,
    stderr,
  }));
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

describe('session CLI', () => {
  it('多行输入作为一条消息提交，真实 search_code 匹配跨行内容', async () => {
    requests.length = 0;
    await writeFile(
      path.join(workspace, 'fixture.txt'),
      `session repository ${MULTILINE_QUERY}`,
    );
    const s = start();
    try {
      await vi.waitFor(() => expect(s.stdout()).toContain('> '));
      s.child.stdin.write(`/multiline\n${MULTILINE_REQUEST}\n/send\n`);
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests[0]?.messages.at(-1)?.content).toBe(MULTILINE_REQUEST);
      const result = requests[1]?.messages.find(
        (message) => message.role === EMessageRole.TOOL,
      );
      expect(JSON.parse(result?.content ?? '')).toMatchObject({
        success: true,
        output: {
          matches: [
            {
              path: 'fixture.txt',
              line: 1,
              column: 20,
              content: MULTILINE_QUERY,
              contentTruncated: false,
            },
          ],
        },
      });
      await vi.waitFor(() => expect(s.stdout()).toContain('contentTruncated'));
      s.child.stdin.end();
      expect((await s.done).code).toBe(0);
    } finally {
      s.child.kill();
      await writeFile(path.join(workspace, 'fixture.txt'), FIXTURE_CONTENT);
    }
  });
  it.each([true, false])(
    '工具结果回传模型，下一轮保留完整工具历史（stream=%s）',
    async (stream) => {
      requests.length = 0;
      const s = start(workspace, stream);
      try {
        await vi.waitFor(() => expect(s.stdout()).toContain('> '));
        s.child.stdin.write(`${TOOL_REQUEST}\n`);
        await vi.waitFor(() => expect(s.stdout()).toContain(FIXTURE_CONTENT));
        s.child.stdin.write(`${FOLLOW_UP_REQUEST}\n`);
        await vi.waitFor(() => expect(s.stdout()).toContain(FOLLOW_UP_ANSWER));
        expect(requests[2]?.messages.map((message) => message.role)).toEqual([
          EMessageRole.SYSTEM,
          EMessageRole.USER,
          EMessageRole.ASSISTANT,
          EMessageRole.TOOL,
          EMessageRole.TOOL,
          EMessageRole.TOOL,
          EMessageRole.TOOL,
          EMessageRole.ASSISTANT,
          EMessageRole.USER,
        ]);
        expect(requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
          LIST_DIRECTORY_TOOL_NAME,
          READ_FILE_TOOL_NAME,
          SEARCH_CODE_TOOL_NAME,
          GIT_STATUS_TOOL_NAME,
        ]);
        const results = requests[1]?.messages
          .filter((message) => message.role === EMessageRole.TOOL)
          .map((message) => JSON.parse(message.content));
        expect(results).toEqual([
          expect.objectContaining({ success: true }),
          expect.objectContaining({
            success: true,
            output: {
              path: 'fixture.txt',
              content: FIXTURE_CONTENT,
              truncated: false,
            },
          }),
          expect.objectContaining({
            success: true,
            output: expect.objectContaining({
              matches: [
                expect.objectContaining({
                  path: 'fixture.txt',
                  content: 'evidence',
                }),
              ],
            }),
          }),
          expect.objectContaining({
            success: true,
            output: expect.objectContaining({
              clean: false,
              entries: [expect.objectContaining({ path: 'fixture.txt' })],
            }),
          }),
        ]);
        expect(
          JSON.parse(requests[3]?.messages.at(-1)?.content ?? ''),
        ).toMatchObject({
          success: true,
          output: { content: FIXTURE_CONTENT },
        });
        expect(
          JSON.parse(requests[2]?.messages[3]?.content ?? ''),
        ).toMatchObject({
          success: true,
          output: {
            entries: expect.arrayContaining([
              expect.objectContaining({ path: 'fixture.txt' }),
            ]),
          },
        });
        expect(requests.every((request) => request.stream === stream)).toBe(
          true,
        );
        s.child.stdin.end();
        expect((await s.done).code).toBe(0);
      } finally {
        s.child.kill();
      }
    },
  );
  it('拒绝真实存在的工作区外文件，并能继续下一轮', async () => {
    requests.length = 0;
    const s = start();
    try {
      await vi.waitFor(() => expect(s.stdout()).toContain('> '));
      s.child.stdin.write(`${OUTSIDE_REQUEST}\n`);
      await vi.waitFor(() => expect(s.stdout()).toContain('success'));
      expect(s.stdout()).not.toContain('outside secret');
      const result = requests[1]?.messages.find(
        (message) => message.role === EMessageRole.TOOL,
      );
      expect(JSON.parse(result?.content ?? '')).toMatchObject({
        success: false,
      });
      s.child.stdin.write('恢复问题\n');
      await vi.waitFor(() => expect(s.stdout()).toContain('回答：恢复问题'));
      s.child.stdin.end();
      expect((await s.done).code).toBe(0);
    } finally {
      s.child.kill();
    }
  });

  it.each(['missing', 'fixture.txt'])(
    '无效工作区 %s 在模型请求前失败',
    async (target) => {
      requests.length = 0;
      const s = start(path.join(workspace, target));
      try {
        const result = await s.done;
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('工作区必须是存在且可访问的目录');
        expect(requests).toHaveLength(0);
      } finally {
        s.child.kill();
      }
    },
  );

  it('多轮携带历史，reset 清除历史，空白不请求模型，exit 正常退出', async () => {
    requests.length = 0;
    const s = start();
    try {
      await vi.waitFor(() => expect(s.stdout()).toContain('> '));
      s.child.stdin.write('\n第一问\n');
      await vi.waitFor(() => expect(s.stdout()).toContain('回答：第一问'));
      s.child.stdin.write('第二问\n');
      await vi.waitFor(() => expect(s.stdout()).toContain('回答：第二问'));
      expect(requests[1]?.messages.slice(1)).toEqual([
        { role: EMessageRole.USER, content: '第一问' },
        { role: EMessageRole.ASSISTANT, content: '回答：第一问' },
        { role: EMessageRole.USER, content: '第二问' },
      ]);
      s.child.stdin.write('/reset\n第三问\n');
      await vi.waitFor(() => expect(s.stdout()).toContain('回答：第三问'));
      expect(requests).toHaveLength(3);
      expect(requests[2]?.messages).toHaveLength(2);
      s.child.stdin.write('/exit\n');
      expect((await s.done).code).toBe(0);
    } finally {
      s.child.kill();
    }
  });

  it('管道多行草稿取消时清除尚未换行的字符', async () => {
    requests.length = 0;
    const s = start();
    try {
      await vi.waitFor(() => expect(s.stdout()).toContain('> '));
      s.child.stdin.write('/multiline\npartial');
      await vi.waitFor(() => expect(s.stdout()).toContain('进入多行输入'));
      s.child.kill('SIGINT');
      await vi.waitFor(() => expect(s.stdout()).toContain('多行草稿已放弃'));
      s.child.stdin.write('新问题\n');
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      expect(requests[0]?.messages.at(-1)?.content).toBe('新问题');
      await vi.waitFor(() => expect(s.stdout()).toContain('回答：新问题'));
      s.child.stdin.end();
      expect((await s.done).code).toBe(0);
    } finally {
      s.child.kill();
    }
  });

  it('进程 SIGINT 取消当前请求后可以继续，空闲 SIGINT 正常退出', async () => {
    requests.length = 0;
    const s = start();
    try {
      await vi.waitFor(() => expect(s.stdout()).toContain('> '));
      s.child.stdin.write('等待取消\n');
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      s.child.kill('SIGINT');
      await vi.waitFor(() => expect(s.stderr()).toContain('当前任务已取消'));
      s.child.stdin.write('恢复问题\n');
      await vi.waitFor(() => expect(s.stdout()).toContain('回答：恢复问题'));
      expect(requests[1]?.messages).toHaveLength(2);
      s.child.kill('SIGINT');
      expect((await s.done).code).toBe(0);
    } finally {
      s.child.kill();
    }
  });

  it('请求失败后允许重试，EOF 退出', async () => {
    const s = start();
    try {
      await vi.waitFor(() => expect(s.stdout()).toContain('> '));
      s.child.stdin.write('模拟错误\n');
      await vi.waitFor(() =>
        expect(s.stderr()).toContain(`[${ModelErrorCode.HTTP}]`),
      );
      s.child.stdin.write('继续\n');
      await vi.waitFor(() => expect(s.stdout()).toContain('回答：继续'));
      s.child.stdin.end();
      expect((await s.done).code).toBe(0);
    } finally {
      s.child.kill();
    }
  });
});
