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

export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  inputSchema: ToolInputSchema<TInput>;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
}
