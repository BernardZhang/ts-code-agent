import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReadFileTool } from './read-file.js';

describe('read-file', () => {
  let temporaryPath: string;
  let rootPath: string;
  const context = () => ({ signal: new AbortController().signal });

  beforeEach(async () => {
    temporaryPath = await mkdtemp(path.join(os.tmpdir(), 'code-agent-read-'));
    rootPath = path.join(temporaryPath, 'project');
    await mkdir(rootPath);
  });

  afterEach(async () => {
    await rm(temporaryPath, { recursive: true, force: true });
  });

  it('读取普通文件，返回相对路径', async () => {
    await writeFile(path.join(rootPath, 'main.ts'), '你好');
    const tool = createReadFileTool({ rootPath, maxBytes: 6 });
    await expect(tool.execute({ path: 'main.ts' }, context())).resolves.toEqual(
      {
        path: 'main.ts',
        content: '你好',
        truncated: false,
      },
    );
  });

  it('支持空文件', async () => {
    await writeFile(path.join(rootPath, 'empty.txt'), '');
    await expect(
      createReadFileTool({ rootPath }).execute(
        { path: 'empty.txt' },
        context(),
      ),
    ).resolves.toMatchObject({ content: '', truncated: false });
  });

  it('截断大文件，不返回超出上限的内容', async () => {
    await writeFile(path.join(rootPath, 'large.txt'), 'a'.repeat(100_000));
    await expect(
      createReadFileTool({ rootPath, maxBytes: 4 }).execute(
        { path: 'large.txt' },
        context(),
      ),
    ).resolves.toMatchObject({ content: 'aaaa', truncated: true });
  });

  it('截断时舍弃不完整的中文或 emoji 字节', async () => {
    for (const content of ['a你好', 'a😀b']) {
      await writeFile(path.join(rootPath, 'utf8.txt'), content);
      await expect(
        createReadFileTool({ rootPath, maxBytes: 3 }).execute(
          { path: 'utf8.txt' },
          context(),
        ),
      ).resolves.toMatchObject({ content: 'a', truncated: true });
    }
  });

  it('拒绝文件原有的非法 UTF-8，包括文件末尾不完整的字符', async () => {
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4, 0xbd])]) {
      await writeFile(path.join(rootPath, 'invalid.txt'), bytes);
      await expect(
        createReadFileTool({ rootPath }).execute(
          { path: 'invalid.txt' },
          context(),
        ),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('拒绝目录及不存在的文件', async () => {
    const tool = createReadFileTool({ rootPath });
    await expect(tool.execute({ path: '.' }, context())).rejects.toThrow(
      '普通文件',
    );
    await expect(
      tool.execute({ path: 'missing.txt' }, context()),
    ).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('拒绝越界路径及指向外部的符号链接', async () => {
    const outsidePath = path.join(temporaryPath, 'private.txt');
    await writeFile(outsidePath, 'private');
    await symlink(outsidePath, path.join(rootPath, 'link.txt'));
    const tool = createReadFileTool({ rootPath });
    for (const requestedPath of ['../private.txt', 'link.txt']) {
      await expect(
        tool.execute({ path: requestedPath }, context()),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('入口已取消时不读取', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createReadFileTool({ rootPath }).execute(
        { path: 'missing.txt' },
        { signal: controller.signal },
      ),
    ).rejects.toHaveProperty('name', 'AbortError');
  });

  it('拒绝非法参数，模型不能覆盖上限', () => {
    const tool = createReadFileTool({ rootPath });
    for (const value of [
      null,
      {},
      { path: '' },
      { path: '  ' },
      { path: 1 },
      { path: 'main.ts', maxBytes: 100 },
    ]) {
      expect(tool.inputSchema.safeParse(value).success).toBe(false);
    }
    expect(tool.inputSchema.safeParse({ path: 'main.ts' }).success).toBe(true);
  });

  it('拒绝非法读取上限', () => {
    for (const maxBytes of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(() => createReadFileTool({ rootPath, maxBytes })).toThrow(
        RangeError,
      );
    }
  });
});
