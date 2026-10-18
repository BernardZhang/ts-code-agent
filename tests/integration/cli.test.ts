import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolErrorCode } from '@ts-code-agent/core';

let receivedToolContent: string | undefined;

let url = '';
const finish = (response: ServerResponse) =>
  response.end(
    JSON.stringify({
      done: true,
      message: { role: 'assistant', content: '' },
    }) + '\n',
  );
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  const input: {
    model: string;
    stream: boolean;
    format?: unknown;
    messages?: Array<{
      role: string;
      content: string;
      tool_name?: string;
    }>;
  } = JSON.parse(body);
  if (input.model === 'missing') {
    response.writeHead(404).end();
    return;
  }
  if (input.model === 'invalid-tool-args') {
    const toolMessage = input.messages?.find(
      (message) => message.role === 'tool',
    );

    if (toolMessage !== undefined) {
      receivedToolContent = toolMessage.content;
      response.end(
        JSON.stringify({
          done: true,
          message: {
            role: 'assistant',
            content: '工具参数不合法，无法完成计算。',
          },
        }),
      );
      return;
    }

    response.end(
      JSON.stringify({
        done: true,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'add',
                arguments: { a: '12', b: 30 },
              },
            },
          ],
        },
      }),
    );
    return;
  }
  if (input.format) {
    response.end(
      JSON.stringify({
        done: true,
        message: {
          role: 'assistant',
          content: '{"task":"learn","steps":["read"]}',
        },
      }),
    );
    return;
  }
  if (!input.stream) {
    response.end(
      JSON.stringify({
        done: true,
        message: { role: 'assistant', content: 'complete' },
      }),
    );
    return;
  }
  response.write(
    JSON.stringify({
      done: false,
      message: { role: 'assistant', content: 'first' },
    }) + '\n',
  );
  if (input.model === 'hang') return;
  const timer = setTimeout(() => finish(response), 150);
  response.on('close', () => clearTimeout(timer));
});

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing server address');
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function run(args: string[]) {
  const child = spawn(
    process.execPath,
    ['apps/cli/dist/main.js', ...args, '--base-url', url],
    { env: { ...process.env, AGENT_TIMEOUT_MS: '3000' } },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const result = once(child, 'close').then(([code]) => ({
    code,
    stdout,
    stderr,
  }));
  return { child, result };
}

describe('built CLI with mock Ollama', () => {
  it('prints text before the stream finishes', async () => {
    const { child, result } = run(['chat', 'hello']);
    await once(child.stdout, 'data');
    expect(child.exitCode).toBeNull();
    expect(await result).toEqual({ code: 0, stdout: 'first\n', stderr: '' });
  });
  it('supports non-streaming and structured output', async () => {
    expect(await run(['chat', 'hello', '--no-stream']).result).toEqual({
      code: 0,
      stdout: 'complete\n',
      stderr: '',
    });
    const result = await run(['structured-demo']).result;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      task: 'learn',
      steps: ['read'],
    });
  });
  it('returns nonzero for HTTP errors', async () => {
    const result = await run(['chat', 'hello', '--model', 'missing']).result;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[http]');
  });
  it('cancels an active response on SIGINT and exits 130', async () => {
    const { child, result } = run(['chat', 'hello', '--model', 'hang']);
    await once(child.stdout, 'data');
    child.kill('SIGINT');
    const output = await result;
    expect(output.code).toBe(130);
    expect(output.stderr).toContain('请求已取消');
  });

  it('将工具参数校验失败结果回传模型', async () => {
    receivedToolContent = undefined;

    const result = await run([
      'tools-demo',
      '请调用 add 工具计算 12 加 30。',
      '--model',
      'invalid-tool-args',
    ]).result;

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('工具参数不合法，无法完成计算。');

    if (receivedToolContent === undefined) {
      throw new Error('模拟服务未收到工具结果');
    }

    const toolResult: unknown = JSON.parse(receivedToolContent);

    expect(toolResult).toMatchObject({
      success: false,
      error: {
        code: ToolErrorCode.INVALID_ARGUMENTS,
      },
    });
  });
});
