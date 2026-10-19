import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolExecutor } from '../tools/executor.js';
import { ToolRegistry } from '../tools/registry.js';
import { AgentRunner, EAgentStatus } from './runner.js';
import type { ModelProvider } from '../model/provider.js';
import { EMessageRole, type ModelMessage } from '../model/messages.js';
import type { ToolDefinition } from '../tools/definition.js';
import { ToolErrorCode } from '../tools/result.js';

const addInputSchema = z.object({
  a: z.number(),
  b: z.number(),
});

type AddInput = z.infer<typeof addInputSchema>;

const addTool: ToolDefinition<AddInput, number> = {
  name: 'add',
  description: '计算两个数字之和',
  inputSchema: addInputSchema,
  parameters: z.toJSONSchema(addInputSchema),
  execute: async (input: AddInput) => {
    return input.a + input.b;
  },
};

describe('AgentRunner', () => {
  it('模型直接回答时，历史包含最终回答且不修改原请求', async () => {
    const generate = vi.fn<ModelProvider['generate']>().mockResolvedValue({
      text: '你好',
      usage: {},
    });
    const provider: ModelProvider = {
      capabilities: {
        structuredOutput: false,
      },
      generate,
      stream() {
        throw new Error('本测试不使用流式生成');
      },
    };

    const toolExecutor = new ToolExecutor(new ToolRegistry());
    const agentRunner = new AgentRunner(provider, toolExecutor);

    const messages: ModelMessage[] = [
      { role: EMessageRole.USER, content: '你好' },
    ];
    const agentResult = await agentRunner.run({
      request: {
        model: 'test-model',
        messages,
      },
      maxSteps: 5,
    });

    expect(agentResult).toMatchObject({
      status: EAgentStatus.COMPLETE,
    });

    expect(agentResult.steps).toBe(1);
    expect(agentResult.messages).toEqual([
      { role: EMessageRole.USER, content: '你好' },
      { role: EMessageRole.ASSISTANT, content: '你好' },
    ]);

    expect(messages).toEqual([{ role: EMessageRole.USER, content: '你好' }]);

    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('连续两轮工具调用后正常完成', async () => {
    const generate = vi
      .fn<ModelProvider['generate']>()
      .mockResolvedValueOnce({
        text: '',
        usage: {},
        toolCalls: [{ name: 'add', arguments: { a: 12, b: 30 } }],
      })
      .mockResolvedValueOnce({
        text: '',
        usage: {},
        toolCalls: [{ name: 'add', arguments: { a: 42, b: 8 } }],
      })
      .mockResolvedValueOnce({
        text: '结果是 50',
        usage: {},
      });

    const provider: ModelProvider = {
      capabilities: {
        structuredOutput: false,
      },
      generate,
      stream() {
        throw new Error('本测试不使用流式生成');
      },
    };
    const registry = new ToolRegistry();
    const toolExecutor = new ToolExecutor(registry);
    const agentRunner = new AgentRunner(provider, toolExecutor);

    registry.register(addTool);

    const messages: ModelMessage[] = [
      { role: EMessageRole.USER, content: '计算 (12 + 30) + 8' },
    ];
    const agentResult = await agentRunner.run({
      request: {
        model: 'test-model',
        messages,
      },
      maxSteps: 3,
    });

    expect(agentResult.status).toBe(EAgentStatus.COMPLETE);
    expect(agentResult.messages.map((message) => message.role)).toEqual([
      EMessageRole.USER,
      EMessageRole.ASSISTANT,
      EMessageRole.TOOL,
      EMessageRole.ASSISTANT,
      EMessageRole.TOOL,
      EMessageRole.ASSISTANT,
    ]);

    const toolMessages = agentResult.messages.filter(
      (message) => message.role === EMessageRole.TOOL,
    );

    expect(toolMessages.map((message) => message.content)).toEqual([
      JSON.stringify({ success: true, output: 42 }),
      JSON.stringify({ success: true, output: 50 }),
    ]);

    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('多次调用工具请求模型调用超出maxSteps', async () => {
    const generate = vi
      .fn<ModelProvider['generate']>()
      .mockResolvedValueOnce({
        text: '',
        usage: {},
        toolCalls: [{ name: 'add', arguments: { a: 12, b: 30 } }],
      })
      .mockResolvedValueOnce({
        text: '',
        usage: {},
        toolCalls: [{ name: 'add', arguments: { a: 42, b: 8 } }],
      })
      .mockResolvedValueOnce({
        text: '结果是 50',
        usage: {},
      });

    const provider: ModelProvider = {
      capabilities: {
        structuredOutput: false,
      },
      generate,
      stream() {
        throw new Error('本测试不使用流式生成');
      },
    };
    const registry = new ToolRegistry();
    const toolExecutor = new ToolExecutor(registry);
    const agentRunner = new AgentRunner(provider, toolExecutor);

    registry.register(addTool);

    const messages: ModelMessage[] = [
      { role: EMessageRole.USER, content: '计算 (12 + 30) + 8' },
    ];
    const agentResult = await agentRunner.run({
      request: {
        model: 'test-model',
        messages,
      },
      maxSteps: 2,
    });

    expect(agentResult.status).toBe(EAgentStatus.MAX_STEPS);
    expect(agentResult.steps).toBe(2);
    expect(agentResult.messages.map((message) => message.role)).toEqual([
      EMessageRole.USER,
      EMessageRole.ASSISTANT,
      EMessageRole.TOOL,
      EMessageRole.ASSISTANT,
      EMessageRole.TOOL,
    ]);

    const toolMessages = agentResult.messages.filter(
      (message) => message.role === EMessageRole.TOOL,
    );

    expect(toolMessages.map((message) => message.content)).toEqual([
      JSON.stringify({ success: true, output: 42 }),
      JSON.stringify({ success: true, output: 50 }),
    ]);

    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('取消会阻止同轮后续工具执行', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (input: AddInput) => {
      controller.abort();
      return input.a + input.b;
    });
    const generate = vi
      .fn<ModelProvider['generate']>()
      .mockResolvedValueOnce({
        text: '',
        usage: {},
        toolCalls: [
          { name: 'add', arguments: { a: 12, b: 30 } },
          { name: 'add', arguments: { a: 42, b: 8 } },
        ],
      })
      .mockResolvedValueOnce({
        text: '结果是 50',
        usage: {},
      });

    const provider: ModelProvider = {
      capabilities: {
        structuredOutput: false,
      },
      generate,
      stream() {
        throw new Error('本测试不使用流式生成');
      },
    };
    const registry = new ToolRegistry();
    const toolExecutor = new ToolExecutor(registry);
    const agentRunner = new AgentRunner(provider, toolExecutor);

    registry.register({
      ...addTool,
      execute,
    });

    const messages: ModelMessage[] = [
      { role: EMessageRole.USER, content: '计算 (12 + 30) + 8' },
    ];

    await expect(
      agentRunner.run({
        request: {
          model: 'test-model',
          messages,
          signal: controller.signal,
        },
        maxSteps: 10,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(execute).toBeCalledTimes(1);
    expect(generate).toBeCalledTimes(1);
  });

  it('参数非法时回传失败，模型修正后完成', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (input: AddInput) => {
      return input.a + input.b;
    });
    const generate = vi
      .fn<ModelProvider['generate']>()
      .mockResolvedValueOnce({
        text: '',
        usage: {},
        toolCalls: [{ name: 'add', arguments: { a: '12', b: 30 } }],
      })
      .mockResolvedValueOnce({
        text: '',
        usage: {},
        toolCalls: [{ name: 'add', arguments: { a: 12, b: 30 } }],
      })
      .mockResolvedValueOnce({
        text: '结果是 42',
        usage: {},
      });

    const provider: ModelProvider = {
      capabilities: {
        structuredOutput: false,
      },
      generate,
      stream() {
        throw new Error('本测试不使用流式生成');
      },
    };
    const registry = new ToolRegistry();
    const toolExecutor = new ToolExecutor(registry);
    const agentRunner = new AgentRunner(provider, toolExecutor);

    registry.register({
      ...addTool,
      execute,
    });

    const messages: ModelMessage[] = [
      { role: EMessageRole.USER, content: '计算 12 + 30' },
    ];

    const agentResult = await agentRunner.run({
      request: {
        model: 'test-model',
        messages,
        signal: controller.signal,
      },
      maxSteps: 10,
    });

    const toolMessages = agentResult.messages.filter(
      (message) => message.role === EMessageRole.TOOL,
    );

    expect(toolMessages).toHaveLength(2);

    const [failedMessage, successMessage] = toolMessages;

    if (!failedMessage || !successMessage) {
      throw new Error('预期有两条工具结果消息');
    }

    // 第一条tool消息内容返回 ToolErrorCode.INVALID_ARGUMENTS
    expect(JSON.parse(failedMessage.content)).toMatchObject({
      success: false,
      error: { code: ToolErrorCode.INVALID_ARGUMENTS },
    });

    // 第二条工具调用成功消息返回断言
    expect(JSON.parse(successMessage.content)).toEqual({
      success: true,
      output: 42,
    });

    expect(agentResult).toMatchObject({
      status: EAgentStatus.COMPLETE,
      steps: 3,
      result: {
        text: '结果是 42',
      },
    });

    expect(execute).toBeCalledTimes(1);
    expect(generate).toBeCalledTimes(3);
  });

  it('Provider请求失败时，agent向上抛出错误，不自动重试', async () => {
    const error = new Error('模拟服务不可用');
    const generate = vi
      .fn<ModelProvider['generate']>()
      .mockRejectedValueOnce(error);

    const provider: ModelProvider = {
      capabilities: { structuredOutput: false },
      generate,
      stream() {
        throw new Error('本测试不使用流式生成');
      },
    };
    const toolExecutor = new ToolExecutor(new ToolRegistry());
    const agentRunner = new AgentRunner(provider, toolExecutor);

    await expect(
      agentRunner.run({
        request: {
          model: 'test-model',
          messages: [{ role: EMessageRole.USER, content: '你好' }],
        },
        maxSteps: 3,
      }),
    ).rejects.toBe(error);

    expect(generate).toBeCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝非法 maxSteps：%s',
    async (maxSteps) => {
      // 复用 Provider、ToolExecutor、AgentRunner 的装配
      const generate = vi
        .fn<ModelProvider['generate']>()
        .mockResolvedValueOnce({
          text: '',
          usage: {},
          toolCalls: [{ name: 'add', arguments: { a: 12, b: 30 } }],
        })
        .mockResolvedValueOnce({
          text: '结果是 42',
          usage: {},
        });

      const provider: ModelProvider = {
        capabilities: {
          structuredOutput: false,
        },
        generate,
        stream() {
          throw new Error('本测试不使用流式生成');
        },
      };
      const registry = new ToolRegistry();
      const toolExecutor = new ToolExecutor(registry);
      const agentRunner = new AgentRunner(provider, toolExecutor);

      await expect(
        agentRunner.run({
          request: {
            model: 'test-model',
            messages: [{ role: EMessageRole.USER, content: '你好' }],
          },
          maxSteps,
        }),
      ).rejects.toThrow('maxSteps 必须是正的安全整数');

      expect(generate).not.toHaveBeenCalled();
    },
  );

  it('取消检查发生在第一次模型请求之前,不发送请求', async () => {
    const controller = new AbortController();
    const generate = vi.fn<ModelProvider['generate']>();
    const provider: ModelProvider = {
      capabilities: { structuredOutput: false },
      generate,
      stream() {
        throw new Error('本测试不使用流式生成');
      },
    };

    const agentRunner = new AgentRunner(
      provider,
      new ToolExecutor(new ToolRegistry()),
    );

    controller.abort();

    await expect(
      agentRunner.run({
        request: {
          model: 'test-model',
          messages: [
            {
              role: EMessageRole.USER,
              content: '你好',
            },
          ],
          signal: controller.signal,
        },
        maxSteps: 10,
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(generate).not.toHaveBeenCalled();
  });
});
