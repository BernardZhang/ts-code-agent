import { spawn } from 'node:child_process';

export const DEFAULT_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const TERMINATION_GRACE_MS = 1000;
const GIT_EXECUTABLE = 'git';
const GIT_ENV_PREFIX = 'GIT_';
const UTF8_ENCODING = 'utf-8';

export enum EGitStatusErrorCode {
  NOT_REPOSITORY = 'git_not_repository',
  PROCESS_FAILED = 'git_process_failed',
  OUTPUT_LIMIT = 'git_output_limit',
  PROTOCOL = 'git_protocol',
}

export class GitStatusError extends Error {
  constructor(
    public readonly code: EGitStatusErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitStatusError';
  }
}

export function validateGitOutputBytes(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_GIT_OUTPUT_BYTES
  ) {
    throw new RangeError(
      `Git 输出上限必须为 1 到 ${MAX_GIT_OUTPUT_BYTES} 之间的整数。`,
    );
  }
}

/** 只运行固定状态命令；输出完整且成功退出后才返回。 */
export function runGitStatus(
  rootPath: string,
  signal: AbortSignal,
  maxOutputBytes = DEFAULT_GIT_OUTPUT_BYTES,
): Promise<string> {
  signal.throwIfAborted();
  validateGitOutputBytes(maxOutputBytes);
  // 防止父进程的 GIT_DIR/GIT_WORK_TREE 等变量改变目标仓库。
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith(GIT_ENV_PREFIX),
    ),
  );
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';

  return new Promise((resolve, reject) => {
    const child = spawn(
      GIT_EXECUTABLE,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ],
      { cwd: rootPath, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      child.kill('SIGTERM');
      if (killTimer === undefined) {
        killTimer = setTimeout(
          () => child.kill('SIGKILL'),
          TERMINATION_GRACE_MS,
        );
        killTimer.unref();
      }
    };
    const onAbort = () => terminate();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      if (failure || signal.aborted) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        failure = new GitStatusError(
          EGitStatusErrorCode.OUTPUT_LIMIT,
          'Git 状态输出超过上限。',
        );
        terminate();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.stdout.on('error', (error: Error) => {
      failure ??= error;
      terminate();
    });
    child.stderr.on('error', (error: Error) => {
      failure ??= error;
      terminate();
    });
    child.on('error', (error: Error) => {
      failure ??= new GitStatusError(
        EGitStatusErrorCode.PROCESS_FAILED,
        '无法启动或运行 Git。',
        { cause: error },
      );
    });
    child.on('close', (code, terminationSignal) => {
      signal.removeEventListener('abort', onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
      try {
        signal.throwIfAborted();
        if (failure) throw failure;
        if (code !== 0) {
          const diagnostic = Buffer.concat(stderr).toString();
          throw new GitStatusError(
            EGitStatusErrorCode.PROCESS_FAILED,
            `Git 状态查询失败（退出码 ${code}，信号 ${terminationSignal ?? '无'}）：${diagnostic}`,
          );
        }
        try {
          resolve(
            new TextDecoder(UTF8_ENCODING, {
              fatal: true,
              ignoreBOM: true,
            }).decode(Buffer.concat(stdout)),
          );
        } catch (cause) {
          throw new GitStatusError(
            EGitStatusErrorCode.PROTOCOL,
            'Git 输出包含无法表示为 UTF-8 的路径。',
            { cause },
          );
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}
