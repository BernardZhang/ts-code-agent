import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSearchCodeTool,
  ESearchIncompleteReason,
} from './search-code.js';

describe('search-code', () => {
  let base: string;
  let rootPath: string;
  const context = () => ({ signal: new AbortController().signal });
  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'code-agent-search-'));
    rootPath = path.join(base, 'project');
    await mkdir(rootPath);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const search = (content: string) =>
    createSearchCodeTool({ rootPath }).execute(
      { path: '.', content },
      context(),
    );

  it('按普通文本区分大小写，返回从 1 开始的行列', async () => {
    await writeFile(path.join(rootPath, 'main.ts'), 'Hello\nx a.b aXb\na.b');
    const result = await search('a.b');
    expect(result.matches).toEqual([
      {
        path: 'main.ts',
        line: 2,
        column: 3,
        content: 'a.b',
        contentTruncated: false,
      },
      {
        path: 'main.ts',
        line: 3,
        column: 1,
        content: 'a.b',
        contentTruncated: false,
      },
    ]);
    expect((await search('hello')).matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });
  it('跨行匹配，搜索词和文件均归一化 CRLF', async () => {
    await writeFile(
      path.join(rootPath, 'main.ts'),
      '前言\r\n  hello\r\nworld\r\n',
    );
    const result = await search('hello\r\nworld');
    expect(result.matches[0]).toMatchObject({
      line: 2,
      column: 3,
      content: 'hello\nworld',
    });
  });
  it('跨读取块和 UTF-8 字符边界匹配，不受 read-file 输出上限影响', async () => {
    await writeFile(
      path.join(rootPath, 'large.ts'),
      'x'.repeat(65535) + '你\r\n好',
    );
    const result = await search('你\n好');
    expect(result.matches[0]).toMatchObject({ line: 1, column: 65536 });
  });
  it('CRLF 在读取块边界处仍归一化', async () => {
    await writeFile(
      path.join(rootPath, 'main.ts'),
      'x'.repeat(65535) + '\r\ny',
    );
    expect((await search('x\ny')).matches[0]).toMatchObject({
      line: 1,
      column: 65535,
    });
  });
  it('包含重叠匹配且不重复报告跨块匹配', async () => {
    await writeFile(path.join(rootPath, 'main.ts'), 'aaa');
    expect((await search('aa')).matches.map((match) => match.column)).toEqual([
      1, 2,
    ]);
  });
  it('忽略依赖和 Git 目录，不跟随循环、外部或断开的链接', async () => {
    await mkdir(path.join(rootPath, '.git'));
    await mkdir(path.join(rootPath, 'node_modules'));
    await writeFile(path.join(rootPath, '.git', 'config'), 'needle');
    await writeFile(path.join(rootPath, 'node_modules', 'dep.ts'), 'needle');
    await writeFile(path.join(base, 'outside.ts'), 'needle');
    await symlink(base, path.join(rootPath, 'external'));
    await symlink(rootPath, path.join(rootPath, 'cycle'));
    await symlink(path.join(base, 'missing'), path.join(rootPath, 'broken'));
    expect((await search('needle')).matches).toEqual([]);
  });
  it('支持指定单文件以及符号链接工作区', async () => {
    await writeFile(path.join(rootPath, 'main.ts'), 'needle');
    const linked = path.join(base, 'linked');
    await symlink(rootPath, linked);
    const result = await createSearchCodeTool({ rootPath: linked }).execute(
      { path: 'main.ts', content: 'needle' },
      context(),
    );
    expect(result.matches[0]?.path).toBe('main.ts');
  });
  it('扫描上限和匹配上限明确标记不完整', async () => {
    await writeFile(path.join(rootPath, 'main.ts'), 'needle needle');
    const input = { path: '.', content: 'needle' };
    const limited = await createSearchCodeTool({
      rootPath,
      maxMatches: 1,
    }).execute(input, context());
    expect(limited.matches).toHaveLength(1);
    expect(limited.incompleteReasons).toContain(
      ESearchIncompleteReason.MATCH_LIMIT,
    );
    const bytes = await createSearchCodeTool({
      rootPath,
      maxScanBytes: 3,
    }).execute(input, context());
    expect(bytes.truncated).toBe(true);
    expect(bytes.incompleteReasons).toContain(
      ESearchIncompleteReason.BYTE_LIMIT,
    );
  });
  it('文件数和条目数上限不会被静默忽略', async () => {
    await writeFile(path.join(rootPath, 'a.ts'), 'x');
    await writeFile(path.join(rootPath, 'b.ts'), 'needle');
    const input = { path: '.', content: 'needle' };
    const files = await createSearchCodeTool({ rootPath, maxFiles: 1 }).execute(
      input,
      context(),
    );
    expect(files.incompleteReasons).toContain(
      ESearchIncompleteReason.FILE_LIMIT,
    );
    const entries = await createSearchCodeTool({
      rootPath,
      maxEntries: 1,
    }).execute(input, context());
    expect(entries.incompleteReasons).toContain(
      ESearchIncompleteReason.ENTRY_LIMIT,
    );
  });
  it('二进制和非法编码文件标记不完整，继续搜索其他文件', async () => {
    await writeFile(path.join(rootPath, 'a.bin'), Buffer.from([0]));
    await writeFile(path.join(rootPath, 'b.txt'), Buffer.from([0xe4, 0xbd]));
    await writeFile(path.join(rootPath, 'c.ts'), 'needle');
    const result = await search('needle');
    expect(result.matches[0]?.path).toBe('c.ts');
    expect(result.incompleteReasons).toEqual(
      expect.arrayContaining([
        ESearchIncompleteReason.BINARY_FILE,
        ESearchIncompleteReason.INVALID_UTF8,
      ]),
    );
  });
  it('拒绝越界，保留取消原因和文件不存在错误', async () => {
    const tool = createSearchCodeTool({ rootPath });
    await expect(
      tool.execute({ path: '..', content: 'x' }, context()),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      tool.execute({ path: 'missing', content: 'x' }, context()),
    ).rejects.toHaveProperty('code', 'ENOENT');
    const controller = new AbortController();
    const reason = new Error('cancel');
    controller.abort(reason);
    await expect(
      tool.execute({ path: '.', content: 'x' }, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
  it('拒绝空搜索词和非法预算', () => {
    const tool = createSearchCodeTool({ rootPath });
    expect(tool.inputSchema.safeParse({ path: '.', content: '' }).success).toBe(
      false,
    );
    expect(
      tool.inputSchema.safeParse({ path: '.', content: '\n' }).success,
    ).toBe(true);
    for (const limit of [0, -1, 1.5, Infinity]) {
      expect(() =>
        createSearchCodeTool({ rootPath, maxMatches: limit }),
      ).toThrow(RangeError);
      expect(() => createSearchCodeTool({ rootPath, maxFiles: limit })).toThrow(
        RangeError,
      );
      expect(() =>
        createSearchCodeTool({ rootPath, maxScanBytes: limit }),
      ).toThrow(RangeError);
    }
  });
});
