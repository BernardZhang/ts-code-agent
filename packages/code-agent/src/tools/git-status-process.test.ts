import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EGitStatusErrorCode, runGitStatus } from './git-status-process.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn() };
});

describe('runGitStatus process lifecycle', () => {
  let child: ChildProcess;
  let stdout: PassThrough;
  let stderr: PassThrough;
  beforeEach(() => {
    child = new ChildProcess();
    stdout = new PassThrough();
    stderr = new PassThrough();
    Object.assign(child, { stdout, stderr });
    vi.mocked(spawn).mockReturnValue(child);
    vi.spyOn(child, 'kill').mockReturnValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('按字节收集拆开的 UTF-8，等待 close 后才完成', async () => {
    const promise = runGitStatus('/workspace', new AbortController().signal);
    const bytes = Buffer.from('?? 中文.ts\0');
    stdout.write(bytes.subarray(0, 4));
    stdout.write(bytes.subarray(4));
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    child.emit('exit', 0, null);
    await Promise.resolve();
    expect(resolved).toBe(false);
    child.emit('close', 0, null);
    await expect(promise).resolves.toBe('?? 中文.ts\0');
    expect(spawn).toHaveBeenCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({ shell: false, cwd: '/workspace' }),
    );
  });

  it('找不到 Git 时报告进程错误并保留 cause', async () => {
    const promise = runGitStatus('/workspace', new AbortController().signal);
    const cause = new Error('missing executable');
    child.emit('error', cause);
    child.emit('close', -1, null);
    await expect(promise).rejects.toMatchObject({
      code: EGitStatusErrorCode.PROCESS_FAILED,
      cause,
    });
  });

  it('非零退出时保留诊断，不能把 stdout 当成成功结果', async () => {
    const promise = runGitStatus('/workspace', new AbortController().signal);
    stdout.write('?? partial.ts\0');
    stderr.write('fatal: failure');
    child.emit('close', 128, null);
    await expect(promise).rejects.toMatchObject({
      code: EGitStatusErrorCode.PROCESS_FAILED,
      message: expect.stringContaining('fatal: failure'),
    });
  });

  it('取消时先终止进程，close 后保留取消原因并清理监听器', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const reason = new Error('cancel');
    const promise = runGitStatus('/workspace', controller.signal);
    controller.abort(reason);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await expect(promise).rejects.toBe(reason);
    expect(remove).toHaveBeenCalled();
  });

  it('合计限制 stdout 和 stderr，必要时升级终止信号', async () => {
    vi.useFakeTimers();
    const promise = runGitStatus('/workspace', new AbortController().signal, 4);
    stdout.write('123');
    stderr.write('45');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(promise).rejects.toHaveProperty(
      'code',
      EGitStatusErrorCode.OUTPUT_LIMIT,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('非 UTF-8 输出明确报协议错误', async () => {
    const promise = runGitStatus('/workspace', new AbortController().signal);
    stdout.write(Buffer.from([0xff]));
    child.emit('close', 0, null);
    await expect(promise).rejects.toHaveProperty(
      'code',
      EGitStatusErrorCode.PROTOCOL,
    );
  });
});
