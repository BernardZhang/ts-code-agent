import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  const input: { model: string; stream: boolean; format?: unknown } =
    JSON.parse(body);
  if (input.model === 'missing') {
    response.writeHead(404).end();
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
});
