import type { ToolDefinition } from '@ts-code-agent/core';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';
import { resolveWorkspacePath } from '../workspace/workspace.js';
import type { Dirent } from 'node:fs';

export const LIST_DIRECTORY_TOOL_NAME = 'list_directory';
export const DEFAULT_MAX_ENTRY_COUNT = 50;
export const MAX_ENTRY_COUNT = 1000;
export const MAX_DEPTH = 100;

const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);

export enum EDirectoryEntryType {
  DIRECTORY = 'directory',
  FILE = 'file',
  LINK = 'link',
}

export interface ListDirectoryOptions {
  rootPath: string; // 工作空间路径
  maxEntryCount?: number;
  maxDepth?: number; // 遍历目录最大深度
  traverseByDeep?: boolean; // 按照深度遍历目录
}

const listDirectoryInputSchema = z.strictObject({
  path: z
    .string()
    .refine((value) => value.trim().length > 0 && !value.includes('\0'), {
      message: '目录路径不能为空或包含空字节。',
    }),
});

export type ListDirectoryInput = z.infer<typeof listDirectoryInputSchema>;

export type ListDirectoryOutput = {
  entries: Array<{
    path: string;
    type: EDirectoryEntryType;
  }>;
  truncated: boolean;
};

interface PendingDirectory {
  directoryPath: string;
  depth: number;
}

const getFileType = (file: Dirent) => {
  if (file.isSymbolicLink()) {
    return EDirectoryEntryType.LINK;
  }

  if (file.isDirectory()) {
    return EDirectoryEntryType.DIRECTORY;
  }

  if (file.isFile()) {
    return EDirectoryEntryType.FILE;
  }
};

const sortFiles = (files: Dirent[]) => {
  return files.sort((a, b) => {
    // 目录优先
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }

    // 文件名称升序排列
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
};

export function createListDirectoryTool(
  options: ListDirectoryOptions,
): ToolDefinition<ListDirectoryInput, ListDirectoryOutput> {
  const rootPath = path.resolve(options.rootPath);
  const maxEntryCount = options.maxEntryCount ?? DEFAULT_MAX_ENTRY_COUNT;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const traverseByDeep = options.traverseByDeep ?? false;

  if (
    !Number.isSafeInteger(maxEntryCount) ||
    maxEntryCount < 0 ||
    maxEntryCount > MAX_ENTRY_COUNT
  ) {
    throw new RangeError(`读取上限必须为 0 到 ${MAX_ENTRY_COUNT} 之间的整数。`);
  }

  if (
    !Number.isSafeInteger(maxDepth) ||
    maxDepth <= 0 ||
    maxDepth > MAX_DEPTH
  ) {
    throw new RangeError(
      `读取目录深度上限必须为 1 到 ${MAX_DEPTH} 之间的整数。`,
    );
  }

  return {
    name: LIST_DIRECTORY_TOOL_NAME,
    description: '列出路径下的所有文件和目录',
    inputSchema: listDirectoryInputSchema,
    parameters: z.toJSONSchema(listDirectoryInputSchema),
    // 遍历工作区目录，限制深度和返回条目数
    async execute(input, { signal }) {
      signal.throwIfAborted();
      const rootRealPath = await resolveWorkspacePath(rootPath, '.');
      const resolvedPath = await resolveWorkspacePath(rootPath, input.path);
      signal.throwIfAborted();

      const entries: ListDirectoryOutput['entries'] = [];

      const pendingDirectoryQueue: PendingDirectory[] = [];

      const traverseDirectory = async (
        directoryPath: string,
        depth: number,
      ) => {
        signal.throwIfAborted();
        const files = sortFiles(
          await readdir(directoryPath, { withFileTypes: true }),
        );

        for (const file of files) {
          const type = getFileType(file);
          const entryPath = path.join(directoryPath, file.name);

          if (
            !type ||
            (type === EDirectoryEntryType.DIRECTORY &&
              IGNORED_DIRECTORY_NAMES.has(file.name))
          ) {
            continue;
          }

          entries.push({
            path: path.relative(rootRealPath, entryPath),
            type,
          });

          // 多保留一条，用于确认结果确实被截断。
          if (entries.length > maxEntryCount) {
            return;
          }

          // 超过最大遍历深度是，不继续递归
          if (type === EDirectoryEntryType.DIRECTORY && depth < maxDepth) {
            if (traverseByDeep) {
              await traverseDirectory(
                await resolveWorkspacePath(rootPath, entryPath),
                depth + 1,
              );
            } else {
              pendingDirectoryQueue.push({
                directoryPath: await resolveWorkspacePath(rootPath, entryPath),
                depth: depth + 1,
              });
            }
            signal.throwIfAborted();
          }
        }
      };

      if (traverseByDeep) {
        await traverseDirectory(resolvedPath, 1);
      } else {
        pendingDirectoryQueue.push({
          directoryPath: resolvedPath,
          depth: 1,
        });

        for (let i = 0; i < pendingDirectoryQueue.length; i++) {
          signal.throwIfAborted();
          if (entries.length > maxEntryCount) break;

          const current = pendingDirectoryQueue[i];

          if (current) {
            await traverseDirectory(current.directoryPath, current.depth);
          }
        }
      }

      signal.throwIfAborted();

      return {
        entries: entries.slice(0, maxEntryCount),
        truncated: entries.length > maxEntryCount,
      };
    },
  };
}
