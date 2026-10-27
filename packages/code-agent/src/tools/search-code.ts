import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '@ts-code-agent/core';
import { z } from 'zod';
import { resolveWorkspacePath } from '../workspace/workspace.js';

export const SEARCH_CODE_TOOL_NAME = 'search_code';
const CHUNK_BYTES = 64 * 1024;
const MAX_QUERY_LENGTH = 16 * 1024;
const MAX_PREVIEW_LENGTH = 240;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);
const UTF8_ENCODING = 'utf-8';

export enum ESearchIncompleteReason {
  MATCH_LIMIT = 'match_limit',
  FILE_LIMIT = 'file_limit',
  ENTRY_LIMIT = 'entry_limit',
  BYTE_LIMIT = 'byte_limit',
  BINARY_FILE = 'binary_file',
  INVALID_UTF8 = 'invalid_utf8',
}

const searchCodeInputSchema = z.strictObject({
  path: z
    .string()
    .refine((value) => value.trim().length > 0 && !value.includes('\0'), {
      message: '文件路径不能为空或包含空字节。',
    }),
  content: z
    .string()
    .min(1)
    .max(MAX_QUERY_LENGTH)
    .refine((value) => !value.includes('\0'), {
      message: '搜索词不能包含空字节。',
    }),
});

export interface SearchCodeOptions {
  rootPath: string;
  maxMatches?: number;
  maxFiles?: number;
  maxEntries?: number;
  maxScanBytes?: number;
}

export type SearchCodeInput = z.infer<typeof searchCodeInputSchema>;

export interface SearchCodeOutput {
  matches: Array<{
    path: string;
    line: number;
    /** 从 1 开始，以 UTF-16 码元计数，与 JS 字符串索引一致。 */
    column: number;
    /** 匹配文本片段，不包含周围代码。 */
    content: string;
    contentTruncated: boolean;
  }>;
  truncated: boolean;
  incompleteReasons: ESearchIncompleteReason[];
}

function checkLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`搜索上限必须为 1 到 ${maximum} 之间的整数。`);
  }
  return value;
}

/** KMP 前缀表：跨读取块保留匹配进度，支持重叠匹配。 */
function buildPrefixTable(query: string): number[] {
  const table = new Array<number>(query.length).fill(0);
  let matched = 0;
  for (let i = 1; i < query.length; i += 1) {
    while (matched > 0 && query[i] !== query[matched])
      matched = table[matched - 1] ?? 0;
    if (query[i] === query[matched]) matched += 1;
    table[i] = matched;
  }
  return table;
}

export function createSearchCodeTool(
  options: SearchCodeOptions,
): ToolDefinition<SearchCodeInput, SearchCodeOutput> {
  const rootPath = path.resolve(options.rootPath);
  const maxMatches = checkLimit(options.maxMatches ?? 100, 1000);
  const maxFiles = checkLimit(options.maxFiles ?? 200, 10_000);
  const maxEntries = checkLimit(options.maxEntries ?? 10_000, 100_000);
  const maxScanBytes = checkLimit(
    options.maxScanBytes ?? 16 * 1024 * 1024,
    256 * 1024 * 1024,
  );

  return {
    name: SEARCH_CODE_TOOL_NAME,
    description:
      '在工作区 UTF-8 文件中搜索区分大小写的普通文本，支持多行、重叠匹配和 CRLF 归一化。返回匹配起始行列及文本片段；truncated 表示未完整搜索指定范围。',
    inputSchema: searchCodeInputSchema,
    parameters: z.toJSONSchema(searchCodeInputSchema),
    async execute(input, { signal }) {
      signal.throwIfAborted();
      const query = searchCodeInputSchema
        .parse(input)
        .content.replace(/\r\n/g, '\n');
      const prefixTable = buildPrefixTable(query);
      const rootRealPath = await resolveWorkspacePath(rootPath, '.');
      const targetPath = await resolveWorkspacePath(rootRealPath, input.path);
      const matches: SearchCodeOutput['matches'] = [];
      const reasons = new Set<ESearchIncompleteReason>();
      let scannedFiles = 0;
      let scannedBytes = 0;
      let visitedEntries = 0;
      let stopped = false;
      const stop = (reason: ESearchIncompleteReason) => {
        reasons.add(reason);
        stopped = true;
      };

      const searchFile = async (filePath: string): Promise<void> => {
        signal.throwIfAborted();
        if (scannedFiles >= maxFiles) {
          stop(ESearchIncompleteReason.FILE_LIMIT);
          return;
        }
        scannedFiles += 1;
        const safePath = await resolveWorkspacePath(rootRealPath, filePath);
        const handle = await open(
          safePath,
          constants.O_RDONLY | constants.O_NONBLOCK,
        );
        const matchStart = matches.length;
        try {
          if (!(await handle.stat()).isFile())
            throw new TypeError('搜索目标必须是普通文件。');
          const decoder = new TextDecoder(UTF8_ENCODING, {
            fatal: true,
            ignoreBOM: true,
          });
          const buffer = Buffer.alloc(CHUNK_BYTES);
          const lines = new Uint32Array(query.length);
          const columns = new Uint32Array(query.length);
          let line = 1;
          let column = 1;
          let position = 0;
          let matched = 0;
          let pendingCR = '';
          const relativePath = path.relative(rootRealPath, safePath);

          const consume = (text: string, final: boolean) => {
            let normalized = pendingCR + text;
            pendingCR = '';
            if (!final && normalized.endsWith('\r')) {
              pendingCR = '\r';
              normalized = normalized.slice(0, -1);
            }
            normalized = normalized.replace(/\r\n/g, '\n');
            for (let i = 0; i < normalized.length && !stopped; i += 1) {
              const character = normalized[i];
              const slot = position % query.length;
              lines[slot] = line;
              columns[slot] = column;
              while (matched > 0 && character !== query[matched])
                matched = prefixTable[matched - 1] ?? 0;
              if (character === query[matched]) matched += 1;
              if (matched === query.length) {
                const start = (position - query.length + 1) % query.length;
                matches.push({
                  path: relativePath,
                  line: lines[start] ?? line,
                  column: columns[start] ?? column,
                  content: query.slice(0, MAX_PREVIEW_LENGTH),
                  contentTruncated: query.length > MAX_PREVIEW_LENGTH,
                });
                matched = prefixTable[matched - 1] ?? 0;
                // 达到上限即停止；不声称一定还存在其他匹配。
                if (matches.length >= maxMatches)
                  stop(ESearchIncompleteReason.MATCH_LIMIT);
              }
              position += 1;
              if (character === '\n') {
                line += 1;
                column = 1;
              } else {
                column += 1;
              }
            }
          };

          while (!stopped) {
            signal.throwIfAborted();
            const remaining = maxScanBytes - scannedBytes;
            const { bytesRead } = await handle.read(
              buffer,
              0,
              Math.min(buffer.length, remaining + 1),
              null,
            );
            signal.throwIfAborted();
            const size = Math.min(bytesRead, remaining);
            const bytes = buffer.subarray(0, size);
            scannedBytes += size;
            if (bytes.includes(0)) {
              reasons.add(ESearchIncompleteReason.BINARY_FILE);
              matches.splice(matchStart);
              break;
            }
            let text: string;
            try {
              text = decoder.decode(bytes, { stream: bytesRead !== 0 });
            } catch (error) {
              if (!(error instanceof TypeError)) throw error;
              reasons.add(ESearchIncompleteReason.INVALID_UTF8);
              matches.splice(matchStart);
              break;
            }
            consume(text, bytesRead === 0);
            if (bytesRead > remaining) {
              stop(ESearchIncompleteReason.BYTE_LIMIT);
              break;
            }
            if (bytesRead === 0) break;
          }
        } finally {
          await handle.close();
        }
      };

      const targetInfo = await stat(targetPath);
      if (targetInfo.isFile()) {
        await searchFile(targetPath);
      } else if (targetInfo.isDirectory()) {
        const queue = [targetPath];
        for (let index = 0; index < queue.length && !stopped; index += 1) {
          signal.throwIfAborted();
          const directory = queue[index];
          if (!directory) break;
          const entries = await readdir(directory, { withFileTypes: true });
          entries.sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          );
          for (const entry of entries) {
            signal.throwIfAborted();
            if (stopped) break;
            if (visitedEntries >= maxEntries) {
              stop(ESearchIncompleteReason.ENTRY_LIMIT);
              break;
            }
            visitedEntries += 1;
            if (entry.isSymbolicLink()) continue;
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
              queue.push(await resolveWorkspacePath(rootRealPath, entryPath));
            } else if (entry.isFile()) {
              await searchFile(entryPath);
            }
          }
        }
      } else {
        throw new TypeError('搜索目标必须是普通文件或目录。');
      }
      signal.throwIfAborted();
      return {
        matches,
        truncated: reasons.size > 0,
        incompleteReasons: [...reasons],
      };
    },
  };
}
