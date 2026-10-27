import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createListDirectoryTool,
  EDirectoryEntryType,
  MAX_DEPTH,
  MAX_ENTRY_COUNT,
} from './list-directory.js';

describe('list-directory', () => {
  let temporaryPath: string;
  let rootPath: string;
  const context = () => ({ signal: new AbortController().signal });

  beforeEach(async () => {
    temporaryPath = await mkdtemp(path.join(os.tmpdir(), 'code-agent-list-'));
    rootPath = path.join(temporaryPath, 'project');
    await mkdir(rootPath);
  });

  afterEach(async () => {
    await rm(temporaryPath, { recursive: true, force: true });
  });

  const createTree = async () => {
    await mkdir(path.join(rootPath, 'a', 'inner'), { recursive: true });
    await mkdir(path.join(rootPath, 'b'));
    await writeFile(path.join(rootPath, 'a', 'inner', 'deep.txt'), 'deep');
    await writeFile(path.join(rootPath, 'b', 'shallow.txt'), 'shallow');
    await writeFile(path.join(rootPath, 'root.txt'), 'root');
  };

  const pathsOf = (entries: Array<{ path: string }>) =>
    entries.map((entry) => entry.path.split(path.sep).join('/'));

  it('返回相对于工作区的路径和普通文件类型', async () => {
    await writeFile(path.join(rootPath, 'main.ts'), 'export {};');
    const result = await createListDirectoryTool({ rootPath }).execute(
      { path: '.' },
      context(),
    );
    expect(result).toEqual({
      entries: [{ path: 'main.ts', type: EDirectoryEntryType.FILE }],
      truncated: false,
    });
  });

  it('默认 BFS 保证全部浅层条目先于深层条目', async () => {
    await createTree();
    const result = await createListDirectoryTool({ rootPath }).execute(
      { path: '.' },
      context(),
    );
    expect(pathsOf(result.entries)).toEqual([
      'a',
      'b',
      'root.txt',
      'a/inner',
      'b/shallow.txt',
      'a/inner/deep.txt',
    ]);
    expect(result.truncated).toBe(false);
  });

  it('DFS 完整访问第一个分支后再访问同级条目', async () => {
    await createTree();
    const result = await createListDirectoryTool({
      rootPath,
      traverseByDeep: true,
    }).execute({ path: '.' }, context());
    expect(pathsOf(result.entries)).toEqual([
      'a',
      'a/inner',
      'a/inner/deep.txt',
      'b',
      'b/shallow.txt',
      'root.txt',
    ]);
  });

  for (const traverseByDeep of [false, true]) {
    describe(`traverseByDeep=${traverseByDeep}`, () => {
      it('空目录不标记截断', async () => {
        await expect(
          createListDirectoryTool({ rootPath, traverseByDeep }).execute(
            { path: '.' },
            context(),
          ),
        ).resolves.toEqual({ entries: [], truncated: false });
      });

      it('深度 1 仅返回直接子项，深度 2 不读取第三层', async () => {
        await createTree();
        const first = await createListDirectoryTool({
          rootPath,
          traverseByDeep,
          maxDepth: 1,
        }).execute({ path: '.' }, context());
        expect(pathsOf(first.entries)).toEqual(['a', 'b', 'root.txt']);
        const second = await createListDirectoryTool({
          rootPath,
          traverseByDeep,
          maxDepth: 2,
        }).execute({ path: '.' }, context());
        expect(pathsOf(second.entries)).not.toContain('a/inner/deep.txt');
        expect(second.entries).toHaveLength(5);
        expect(second.truncated).toBe(false);
      });

      it('超过数量上限时返回正确顺序的前缀和截断标记', async () => {
        await createTree();
        const full = await createListDirectoryTool({
          rootPath,
          traverseByDeep,
        }).execute({ path: '.' }, context());
        const limited = await createListDirectoryTool({
          rootPath,
          traverseByDeep,
          maxEntryCount: 2,
        }).execute({ path: '.' }, context());
        expect(limited.entries).toEqual(full.entries.slice(0, 2));
        expect(limited.truncated).toBe(true);
      });

      it('条目数恰好等于上限不标记截断', async () => {
        await createTree();
        const result = await createListDirectoryTool({
          rootPath,
          traverseByDeep,
          maxEntryCount: 6,
        }).execute({ path: '.' }, context());
        expect(result.entries).toHaveLength(6);
        expect(result.truncated).toBe(false);
      });

      it('数量上限为零时区分空目录和非空目录', async () => {
        const tool = createListDirectoryTool({
          rootPath,
          traverseByDeep,
          maxEntryCount: 0,
        });
        await expect(tool.execute({ path: '.' }, context())).resolves.toEqual({
          entries: [],
          truncated: false,
        });
        await writeFile(path.join(rootPath, 'file.txt'), '');
        await expect(tool.execute({ path: '.' }, context())).resolves.toEqual({
          entries: [],
          truncated: true,
        });
      });
    });
  }

  it('目录优先，同类按名称排序，不受创建顺序影响', async () => {
    await writeFile(path.join(rootPath, 'z.txt'), '');
    await mkdir(path.join(rootPath, 'z-dir'));
    await writeFile(path.join(rootPath, 'a.txt'), '');
    await mkdir(path.join(rootPath, 'a-dir'));
    const result = await createListDirectoryTool({ rootPath }).execute(
      { path: '.' },
      context(),
    );
    expect(pathsOf(result.entries)).toEqual([
      'a-dir',
      'z-dir',
      'a.txt',
      'z.txt',
    ]);
    expect(
      result.entries
        .slice(0, 2)
        .every((entry) => entry.type === EDirectoryEntryType.DIRECTORY),
    ).toBe(true);
  });

  it('各层忽略 .git 和 node_modules，忽略项不触发截断', async () => {
    await mkdir(path.join(rootPath, '.git'));
    await mkdir(path.join(rootPath, 'src', 'node_modules'), {
      recursive: true,
    });
    await writeFile(path.join(rootPath, '.git', 'config'), '');
    await writeFile(
      path.join(rootPath, 'src', 'node_modules', 'hidden.txt'),
      '',
    );
    const result = await createListDirectoryTool({
      rootPath,
      maxEntryCount: 1,
    }).execute({ path: '.' }, context());
    expect(pathsOf(result.entries)).toEqual(['src']);
    expect(result.truncated).toBe(false);
  });

  it('符号链接仅展示，不跟随外部目标、断链或父目录循环', async () => {
    await symlink(rootPath, path.join(rootPath, 'cycle'));
    await symlink(temporaryPath, path.join(rootPath, 'outside'));
    await symlink(
      path.join(temporaryPath, 'missing'),
      path.join(rootPath, 'broken'),
    );
    const result = await createListDirectoryTool({ rootPath }).execute(
      { path: '.' },
      context(),
    );
    expect(pathsOf(result.entries)).toEqual(['broken', 'cycle', 'outside']);
    expect(
      result.entries.every((entry) => entry.type === EDirectoryEntryType.LINK),
    ).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('工作区根目录为符号链接时仍返回正确的工作区相对路径', async () => {
    await createTree();
    const linkedRoot = path.join(temporaryPath, 'linked');
    await symlink(rootPath, linkedRoot);
    const result = await createListDirectoryTool({
      rootPath: linkedRoot,
    }).execute({ path: 'b' }, context());
    expect(pathsOf(result.entries)).toEqual(['b/shallow.txt']);
  });

  it('拒绝父目录、相似前缀目录及指向外部的输入链接', async () => {
    const sibling = path.join(temporaryPath, 'project-backup');
    await mkdir(sibling);
    await symlink(sibling, path.join(rootPath, 'external'));
    const tool = createListDirectoryTool({ rootPath });
    for (const requestedPath of ['..', sibling, 'external']) {
      await expect(
        tool.execute({ path: requestedPath }, context()),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('保留目标不存在和目标非目录的文件系统错误', async () => {
    await writeFile(path.join(rootPath, 'file.txt'), '');
    const tool = createListDirectoryTool({ rootPath });
    await expect(
      tool.execute({ path: 'missing' }, context()),
    ).rejects.toHaveProperty('code', 'ENOENT');
    await expect(
      tool.execute({ path: 'file.txt' }, context()),
    ).rejects.toHaveProperty('code', 'ENOTDIR');
  });

  it('入口取消时保留原始取消原因', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel test');
    controller.abort(reason);
    await expect(
      createListDirectoryTool({ rootPath }).execute(
        { path: '.' },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });

  it('校验模型参数，拒绝空路径、空字节和模型覆盖配置', () => {
    const tool = createListDirectoryTool({ rootPath });
    for (const value of [
      null,
      {},
      { path: '' },
      { path: ' ' },
      { path: '\0' },
      { path: 1 },
      { path: '.', maxDepth: 100 },
    ]) {
      expect(tool.inputSchema.safeParse(value).success).toBe(false);
    }
    expect(tool.inputSchema.safeParse({ path: '.' }).success).toBe(true);
  });

  it('拒绝非法数量和深度配置', () => {
    for (const maxEntryCount of [-1, 1.5, NaN, Infinity, MAX_ENTRY_COUNT + 1]) {
      expect(() =>
        createListDirectoryTool({ rootPath, maxEntryCount }),
      ).toThrow(RangeError);
    }
    for (const maxDepth of [0, -1, 1.5, NaN, Infinity, MAX_DEPTH + 1]) {
      expect(() => createListDirectoryTool({ rootPath, maxDepth })).toThrow(
        RangeError,
      );
    }
  });
});
