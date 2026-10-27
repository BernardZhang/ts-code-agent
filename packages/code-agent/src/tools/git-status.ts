import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '@ts-code-agent/core';
import { z } from 'zod';
import { resolveWorkspacePath } from '../workspace/workspace.js';
import { parseGitStatus, type GitStatusEntry } from './git-status-parser.js';
import {
  DEFAULT_GIT_OUTPUT_BYTES,
  EGitStatusErrorCode,
  GitStatusError,
  runGitStatus,
  validateGitOutputBytes,
} from './git-status-process.js';

export const GIT_STATUS_TOOL_NAME = 'git_status';
const GIT_METADATA_NAME = '.git';
const FILE_NOT_FOUND = 'ENOENT';
const inputSchema = z.strictObject({});

export interface GitStatusToolOptions {
  /** 当前阶段要求工作区就是普通仓库或 linked worktree 的根目录。 */
  rootPath: string;
  maxOutputBytes?: number;
}
export type GitStatusInput = z.infer<typeof inputSchema>;
export interface GitStatusOutput {
  clean: boolean;
  entries: GitStatusEntry[];
}

export function createGitStatusTool(
  options: GitStatusToolOptions,
): ToolDefinition<GitStatusInput, GitStatusOutput> {
  const rootPath = path.resolve(options.rootPath);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES;
  validateGitOutputBytes(maxOutputBytes);

  return {
    name: GIT_STATUS_TOOL_NAME,
    description:
      '查询工作区仓库的 Git 状态，区分暂存区、工作区、未跟踪和冲突状态；不返回被忽略的文件。工作区必须是仓库根目录。',
    inputSchema,
    parameters: z.toJSONSchema(inputSchema),
    async execute(input, { signal }) {
      signal.throwIfAborted();
      inputSchema.parse(input);
      const rootRealPath = await resolveWorkspacePath(rootPath, '.');
      // 拒绝从任意子目录向上发现父仓库，避免返回工作区外的状态。
      try {
        const metadata = await stat(path.join(rootRealPath, GIT_METADATA_NAME));
        if (!metadata.isDirectory() && !metadata.isFile()) {
          throw new GitStatusError(
            EGitStatusErrorCode.NOT_REPOSITORY,
            '工作区必须是 Git 仓库根目录。',
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === FILE_NOT_FOUND
        ) {
          throw new GitStatusError(
            EGitStatusErrorCode.NOT_REPOSITORY,
            '工作区不是 Git 仓库根目录。',
            { cause: error },
          );
        }
        throw error;
      }
      signal.throwIfAborted();
      const output = await runGitStatus(rootRealPath, signal, maxOutputBytes);
      let entries: GitStatusEntry[];
      try {
        entries = parseGitStatus(output);
      } catch (cause) {
        throw new GitStatusError(
          EGitStatusErrorCode.PROTOCOL,
          'Git 状态输出格式不合法。',
          { cause },
        );
      }
      return { clean: entries.length === 0, entries };
    },
  };
}
