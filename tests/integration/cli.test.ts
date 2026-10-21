import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EContextErrorCode,
  EMessageRole,
  ETaskStepStatus,
  ToolErrorCode,
} from '@ts-code-agent/core';

let receivedToolContent: string | undefined;
let receivedPlanRequest: unknown;

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
  if (input.model === 'plan-demo-test') {
    receivedPlanRequest = input;
    response.end(
      JSON.stringify({
        done: true,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            goal: '修复测试',
            steps: ['定位原因', '修复问题'],
          }),
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
  it('plan-demo 发送规划规则、用户任务和 Schema，输出带状态的计划', async () => {
    receivedPlanRequest = undefined;
    const prompt = '帮我修复失败的测试';
    const result = await run(['plan-demo', prompt, '--model', 'plan-demo-test'])
      .result;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      goal: '修复测试',
      steps: [
        { id: 0, description: '定位原因', status: ETaskStepStatus.PENDING },
        { id: 1, description: '修复问题', status: ETaskStepStatus.PENDING },
      ],
    });
    expect(receivedPlanRequest).toMatchObject({
      stream: false,
      messages: [
        {
          role: EMessageRole.SYSTEM,
          content: expect.stringContaining('只生成计划'),
        },
        { role: EMessageRole.USER, content: prompt },
      ],
      format: {
        type: 'object',
        required: expect.arrayContaining(['goal', 'steps']),
        properties: { goal: { type: 'string' }, steps: { type: 'array' } },
      },
    });
  });
  it('context-demo 离线保留最新计划和用户轮次，裁掉旧对话', async () => {
    // 命令没有模型参数；无效配置证明它不会装配或访问 Provider。
    const child = spawn(
      process.execPath,
      ['apps/cli/dist/main.js', 'context-demo'],
      {
        env: {
          ...process.env,
          AGENT_BASE_URL: 'invalid-url',
          AGENT_CONTEXT_LENGTH: 'invalid',
        },
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
    const [code] = await once(child, 'close');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const output: unknown = JSON.parse(stdout);
    const plan = {
      goal: '修复失败测试',
      steps: [
        { id: 0, description: '定位原因', status: ETaskStepStatus.COMPLETED },
        { id: 1, description: '修复实现', status: ETaskStepStatus.IN_PROGRESS },
        { id: 2, description: '运行测试验证', status: ETaskStepStatus.PENDING },
      ],
    };
    const context = [
      {
        role: EMessageRole.SYSTEM,
        content: `以下是演示用的当前计划；步骤状态不等于任务已验证成功。\n${JSON.stringify(plan)}`,
      },
      { role: EMessageRole.USER, content: '继续修复' },
    ];
    const cost = context.reduce(
      (total, message) => total + JSON.stringify(message).length,
      0,
    );
    expect(output).toEqual({
      budgetUnit: '模拟 token 成本（JSON 序列化字符数，非真实 token）',
      messageBudget: cost,
      estimatedContextCost: cost,
      plan,
      historyMessageCount: 4,
      contextMessageCount: 2,
      context,
    });
  });
  it('agent-demo 使用配置容量和工具描述预算，保留正常回答输出', async () => {
    const result = await run([
      'agent-demo',
      '计算 1 + 2',
      '--context-length',
      '8192',
    ]).result;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('complete\n');
    expect(result.stderr).toContain('启发式 token 估算');
    expect(result.stderr).toContain('模型请求 1 次');
  });

  it('agent-demo 的配置容量不足时不请求模型', async () => {
    // 若触发模型请求，mock 会返回 HTTP 错误；预算失败应发生在请求前。
    const result = await run([
      'agent-demo',
      '计算 1 + 2',
      '--context-length',
      '256',
      '--model',
      'missing',
    ]).result;
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('[http]');
    expect(result.stderr).toContain(`[${EContextErrorCode.BUDGET_EXCEEDED}]`);
    expect(result.stderr).toContain('上下文空间已满');
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
