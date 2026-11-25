import { loadEnvFile } from 'node:process';
import { ModelError, ModelErrorCode } from '@ts-code-agent/core';

const MISSING_FILE_CODE = 'ENOENT';

/** 从当前工作目录加载 .env，Node 原生加载器保留已有环境变量。 */
export function loadEnv(filePath = '.env'): void {
  try {
    loadEnvFile(filePath);
  } catch (cause) {
    // 配置文件为可选项；读取失败时不把文件内容或凭据写入日志。
    if (
      cause instanceof Error &&
      'code' in cause &&
      cause.code === MISSING_FILE_CODE
    ) {
      return;
    }
    throw new ModelError(
      ModelErrorCode.VALIDATION,
      '无法读取 .env，请检查文件类型和读取权限。',
      { cause },
    );
  }
}
