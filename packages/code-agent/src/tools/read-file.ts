import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '@ts-code-agent/core';
import { z } from 'zod';
import { resolveWorkspacePath } from '../workspace/workspace.js';

export const READ_FILE_TOOL_NAME = 'read_file';
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;
const UTF8_ENCODING = 'utf-8';

const readFileInputSchema = z.strictObject({
  path: z
    .string()
    .refine((value) => value.trim().length > 0 && !value.includes('\0'), {
      message: '文件路径不能为空或包含空字节。',
    }),
});

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export interface ReadFileToolOptions {
  rootPath: string;
  maxBytes?: number;
}

export interface ReadFileOutput {
  path: string; // 相对于工作区路径
  content: string; // 实际读取到的内容
  truncated: boolean; // 是否还有内容未返回
}

/** 创建只读文本工具；读取上限由装配方设置，模型不能覆盖。 */
export function createReadFileTool(
  options: ReadFileToolOptions,
): ToolDefinition<ReadFileInput, ReadFileOutput> {
  const rootPath = path.resolve(options.rootPath);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_READ_BYTES
  ) {
    throw new RangeError(`读取上限必须为 1 到 ${MAX_READ_BYTES} 之间的整数。`);
  }

  return {
    name: READ_FILE_TOOL_NAME,
    description: '读取工作区内的 UTF-8 文本文件，超出读取上限时返回截断标记。',
    parameters: z.toJSONSchema(readFileInputSchema),
    inputSchema: readFileInputSchema,
    async execute(input, { signal }) {
      signal.throwIfAborted();
      const rootRealPath = await realpath(rootPath);
      const targetPath = await resolveWorkspacePath(rootRealPath, input.path);
      signal.throwIfAborted();

      // 非阻塞打开，避免目标被替换成 FIFO 时无限等待；打开后再次检查类型。
      const handle = await open(
        targetPath,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        signal.throwIfAborted();
        if (!(await handle.stat()).isFile()) {
          throw new TypeError('读取目标必须是普通文件。');
        }
        // 多读一个字节探测截断；循环处理文件系统可能出现的短读。
        const buffer = Buffer.alloc(maxBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          signal.throwIfAborted();
          const result = await handle.read(
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            bytesRead,
          );
          signal.throwIfAborted();
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }

        const truncated = bytesRead > maxBytes;
        const bytes = buffer.subarray(0, Math.min(bytesRead, maxBytes));
        // 截断时暂存并舍弃不完整的尾部字符；完整文件则验证所有 UTF-8 字节。
        const decoder = new TextDecoder(UTF8_ENCODING, { fatal: true });
        const content = decoder.decode(bytes, { stream: truncated });
        return {
          path: path.relative(rootRealPath, targetPath),
          content,
          truncated,
        };
      } finally {
        await handle.close();
      }
    },
  };
}
