import { describe, expect, it } from 'vitest';
import { EGitFileStatus, parseGitStatus } from './git-status-parser.js';

describe('parseGitStatus', () => {
  it('空输出表示没有状态条目', () => {
    expect(parseGitStatus('')).toEqual([]);
  });

  it('保留暂存区与工作区两个独立状态', () => {
    expect(
      parseGitStatus(' M src/main.ts\0MM src/both.ts\0A  new.ts\0'),
    ).toEqual([
      {
        path: 'src/main.ts',
        indexStatus: EGitFileStatus.UNCHANGED,
        worktreeStatus: EGitFileStatus.MODIFIED,
      },
      {
        path: 'src/both.ts',
        indexStatus: EGitFileStatus.MODIFIED,
        worktreeStatus: EGitFileStatus.MODIFIED,
      },
      {
        path: 'new.ts',
        indexStatus: EGitFileStatus.ADDED,
        worktreeStatus: EGitFileStatus.UNCHANGED,
      },
    ]);
  });

  it('未跟踪和忽略文件保持两位协议状态', () => {
    expect(parseGitStatus('?? notes.txt\0!! ignored.txt\0')).toEqual([
      {
        path: 'notes.txt',
        indexStatus: EGitFileStatus.UNTRACKED,
        worktreeStatus: EGitFileStatus.UNTRACKED,
      },
      {
        path: 'ignored.txt',
        indexStatus: EGitFileStatus.IGNORED,
        worktreeStatus: EGitFileStatus.IGNORED,
      },
    ]);
  });

  it('保留文件名中的空格、换行、制表符、反斜杠和中文', () => {
    const names = [
      ' file with spaces ',
      'line\nbreak.ts',
      'tab\tname.ts',
      'back\\slash.ts',
      '中文.ts',
    ];
    const result = parseGitStatus(names.map((name) => `?? ${name}\0`).join(''));
    expect(result.map((entry) => entry.path)).toEqual(names);
  });

  it('重命名和复制消费第二个路径，后面的普通记录仍正确解析', () => {
    expect(
      parseGitStatus('R  new.ts\0old.ts\0CM copy.ts\0source.ts\0?? next.ts\0'),
    ).toEqual([
      {
        path: 'new.ts',
        originalPath: 'old.ts',
        indexStatus: EGitFileStatus.RENAMED,
        worktreeStatus: EGitFileStatus.UNCHANGED,
      },
      {
        path: 'copy.ts',
        originalPath: 'source.ts',
        indexStatus: EGitFileStatus.COPIED,
        worktreeStatus: EGitFileStatus.MODIFIED,
      },
      {
        path: 'next.ts',
        indexStatus: EGitFileStatus.UNTRACKED,
        worktreeStatus: EGitFileStatus.UNTRACKED,
      },
    ]);
  });

  it('原路径即使看起来像状态记录，也按完整路径保留', () => {
    expect(parseGitStatus('R  new.ts\0?? old.ts\0')[0]?.originalPath).toBe(
      '?? old.ts',
    );
  });

  it.each(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])(
    '保留冲突组合 %s，不误作重命名',
    (pair) => {
      const result = parseGitStatus(`${pair} conflict.ts\0`);
      expect(result).toHaveLength(1);
      expect(result[0]?.originalPath).toBeUndefined();
    },
  );

  it.each([
    ' M file.ts',
    ' M \0',
    ' Mxfile.ts\0',
    'ZZ file.ts\0',
    '?M file.ts\0',
    '  file.ts\0',
    'DM file.ts\0',
    'R  new.ts\0',
    'R  new.ts\0\0',
    '?? a\0\0',
  ])('拒绝格式不完整或非法组合 %j', (output) => {
    expect(() => parseGitStatus(output)).toThrow(SyntaxError);
  });
});
