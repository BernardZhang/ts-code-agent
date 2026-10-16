import type { ToolDefinition, ToolExecutionContext } from './definition.js';
import { ToolErrorCode, type ToolResult } from './result.js';

export interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  invoke(
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}

export function registerTool<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
): RegisteredTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    invoke: async (
      rawArguments: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolResult> => {
      const parsed = tool.inputSchema.safeParse(rawArguments);

      // input arguments are invalid, return an error result
      if (!parsed.success) {
        return {
          success: false,
          error: {
            code: ToolErrorCode.INVALID_ARGUMENTS,
            message: parsed.error.message,
          },
        };
      }

      try {
        return {
          success: true,
          output: await tool.execute(parsed.data, context),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: ToolErrorCode.EXECUTION_FAILED,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}

export class ToolRegistry {
  private readonly tools: Map<string, RegisteredTool> = new Map();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool with name "${tool.name}" is already registered.`);
    }

    this.tools.set(tool.name, registerTool(tool));
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
}
