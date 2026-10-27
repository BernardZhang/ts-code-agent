import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * 判断目标是否位于工作区内，允许目标等于工作区根目录。
 * 调用方需先通过 realpath 解析两个路径；本函数只判断路径关系。
 */
export function isWithinWorkspace(
  rootPath: string,
  targetPath: string,
): boolean {
  const relativePath = path.relative(rootPath, targetPath);

  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    // 跨平台window 场景兼容：
    !path.isAbsolute(relativePath)
  );
}

/** 将请求路径解析为工作区内的真实路径；目标必须已经存在。 */
export async function resolveWorkspacePath(
  rootPath: string,
  requestedPath: string,
): Promise<string> {
  const rootRealPath = await realpath(rootPath);
  const absolutePath = path.resolve(rootRealPath, requestedPath);
  const targetRealPath = await realpath(absolutePath);

  if (!isWithinWorkspace(rootRealPath, targetRealPath)) {
    throw new RangeError('请求路径超出工作区范围。');
  }

  return targetRealPath;
}
