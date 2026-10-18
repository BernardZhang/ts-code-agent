export interface ToolExecutionContext {
  signal: AbortSignal;
}

export interface ToolInputSchema<TInput> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: TInput }
    | { success: false; error: { message: string } };
}

export interface ToolDescription {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolDefinition<TInput, TOutput> extends ToolDescription {
  inputSchema: ToolInputSchema<TInput>;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
}
