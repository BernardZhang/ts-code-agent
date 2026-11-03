import { z } from 'zod';
import type { ToolDefinition } from '@ts-code-agent/core';

const addInputSchema = z.object({
  a: z.number(),
  b: z.number(),
});

type AddInput = z.infer<typeof addInputSchema>;

export const addTool: ToolDefinition<AddInput, number> = {
  name: 'add',
  description: '计算两个数字之和',
  inputSchema: addInputSchema,
  parameters: z.toJSONSchema(addInputSchema),
  execute: async (input: AddInput) => {
    return input.a + input.b;
  },
};
