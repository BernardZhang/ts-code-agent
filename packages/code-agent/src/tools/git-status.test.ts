import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitStatusTool } from './git-status.js';
import { EGitFileStatus } from './git-status-parser.js';
import { EGitStatusErrorCode } from './git-status-process.js';

const exec = promisify(execFile);
describe('git-status tool', () => {
  let rootPath: string;
  const context = () => ({ signal: new AbortController().signal });
  beforeEach(async () => {
    rootPath = await mkdtemp(path.join(os.tmpdir(), 'code-agent-git-'));
  });
  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });
  const init = async () => {
    await exec('git', ['init', '--quiet', rootPath]);
  };

  it('空仓库返回 clean，不创建提交', async () => {
    await init();
    await expect(
      createGitStatusTool({ rootPath }).execute({}, context()),
    ).resolves.toEqual({ clean: true, entries: [] });
  });
  it('准确保留已暂存、暂存后再修改、未跟踪及特殊路径', async () => {
    await init();
    await writeFile(path.join(rootPath, 'staged.ts'), 'first');
    await exec('git', ['add', '--', 'staged.ts'], { cwd: rootPath });
    await writeFile(path.join(rootPath, 'staged.ts'), 'second');
    const name = '空 格\nfile.ts';
    await writeFile(path.join(rootPath, name), 'new');
    const result = await createGitStatusTool({ rootPath }).execute(
      {},
      context(),
    );
    expect(result.clean).toBe(false);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        {
          path: 'staged.ts',
          indexStatus: EGitFileStatus.ADDED,
          worktreeStatus: EGitFileStatus.MODIFIED,
        },
        {
          path: name,
          indexStatus: EGitFileStatus.UNTRACKED,
          worktreeStatus: EGitFileStatus.UNTRACKED,
        },
      ]),
    );
  });
  it('非仓库及仓库子目录明确失败，避免向上发现外部仓库', async () => {
    await expect(
      createGitStatusTool({ rootPath }).execute({}, context()),
    ).rejects.toHaveProperty('code', EGitStatusErrorCode.NOT_REPOSITORY);
    await init();
    const child = path.join(rootPath, 'child');
    await mkdir(child);
    await expect(
      createGitStatusTool({ rootPath: child }).execute({}, context()),
    ).rejects.toHaveProperty('code', EGitStatusErrorCode.NOT_REPOSITORY);
  });
  it('支持符号链接指向仓库根目录', async () => {
    const repo = path.join(rootPath, 'repo');
    await exec('git', ['init', '--quiet', repo]);
    const link = path.join(rootPath, 'link');
    await symlink(repo, link);
    await expect(
      createGitStatusTool({ rootPath: link }).execute({}, context()),
    ).resolves.toMatchObject({ clean: true });
  });
  it('输出超限明确失败，不返回部分结果', async () => {
    await init();
    await writeFile(path.join(rootPath, 'long-file-name.ts'), '');
    await expect(
      createGitStatusTool({ rootPath, maxOutputBytes: 4 }).execute(
        {},
        context(),
      ),
    ).rejects.toHaveProperty('code', EGitStatusErrorCode.OUTPUT_LIMIT);
  });
  it('保留入口取消原因，拒绝模型传参和非法预算', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    const tool = createGitStatusTool({ rootPath });
    await expect(tool.execute({}, { signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(tool.inputSchema.safeParse({ path: '..' }).success).toBe(false);
    for (const maxOutputBytes of [0, -1, 1.5, Infinity]) {
      expect(() => createGitStatusTool({ rootPath, maxOutputBytes })).toThrow(
        RangeError,
      );
    }
  });
});
