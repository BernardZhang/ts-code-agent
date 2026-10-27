import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspacePath } from './workspace.js';

describe('resolveWorkspacePath', () => {
  let temporaryPath: string;
  let rootPath: string;

  beforeEach(async () => {
    temporaryPath = await mkdtemp(
      path.join(os.tmpdir(), 'code-agent-workspace-'),
    );
    rootPath = path.join(temporaryPath, 'project');
    await mkdir(rootPath);
    await writeFile(path.join(rootPath, 'main.ts'), 'export {};');
    await writeFile(path.join(temporaryPath, 'private.txt'), 'outside');
  });

  afterEach(async () => {
    await rm(temporaryPath, { recursive: true, force: true });
  });

  it('以工作区为起点解析相对路径，也允许内部绝对路径', async () => {
    const expected = await realpath(path.join(rootPath, 'main.ts'));
    await expect(resolveWorkspacePath(rootPath, 'main.ts')).resolves.toBe(
      expected,
    );
    await expect(resolveWorkspacePath(rootPath, expected)).resolves.toBe(
      expected,
    );
  });

  it('允许工作区根目录本身', async () => {
    await expect(resolveWorkspacePath(rootPath, '.')).resolves.toBe(
      await realpath(rootPath),
    );
  });

  it('拒绝父目录、外部文件及相似前缀目录', async () => {
    const siblingPath = path.join(temporaryPath, 'project-backup');
    await mkdir(siblingPath);
    for (const requestedPath of ['..', '../private.txt', siblingPath]) {
      await expect(
        resolveWorkspacePath(rootPath, requestedPath),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it('拒绝指向工作区外部的符号链接', async () => {
    await symlink(
      path.join(temporaryPath, 'private.txt'),
      path.join(rootPath, 'link.txt'),
    );
    await expect(
      resolveWorkspacePath(rootPath, 'link.txt'),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('解析工作区和内部文件的符号链接', async () => {
    const linkedRoot = path.join(temporaryPath, 'linked-project');
    await symlink(rootPath, linkedRoot);
    await symlink(
      path.join(rootPath, 'main.ts'),
      path.join(rootPath, 'link.ts'),
    );
    await expect(resolveWorkspacePath(linkedRoot, 'link.ts')).resolves.toBe(
      await realpath(path.join(rootPath, 'main.ts')),
    );
  });

  it('目标或工作区不存在时保留文件系统错误', async () => {
    await expect(
      resolveWorkspacePath(rootPath, 'missing.ts'),
    ).rejects.toHaveProperty('code', 'ENOENT');
    await expect(
      resolveWorkspacePath(path.join(temporaryPath, 'missing'), '.'),
    ).rejects.toHaveProperty('code', 'ENOENT');
  });
});
