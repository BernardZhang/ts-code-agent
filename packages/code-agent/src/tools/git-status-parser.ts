/** Git porcelain v1 外部协议中的单字符状态。 */
export enum EGitFileStatus {
  UNCHANGED = ' ',
  MODIFIED = 'M',
  ADDED = 'A',
  DELETED = 'D',
  RENAMED = 'R',
  COPIED = 'C',
  TYPE_CHANGED = 'T',
  UNMERGED = 'U',
  UNTRACKED = '?',
  IGNORED = '!',
}

export interface GitStatusEntry {
  path: string;
  originalPath?: string;
  /** 冲突时需要将两个状态作为组合解释。 */
  indexStatus: EGitFileStatus;
  worktreeStatus: EGitFileStatus;
}

const NUL = '\0';
const FIELD_SEPARATOR = ' ';
const PATH_OFFSET = 3;
// 协议边界集中列出官方文档中的组合，避免接受任意两个合法字符。
const VALID_STATUS_PAIRS = new Set([
  ' M',
  ' T',
  ' A',
  ' D',
  ' R',
  ' C',
  'M ',
  'MM',
  'MT',
  'MD',
  'T ',
  'TM',
  'TT',
  'TD',
  'A ',
  'AM',
  'AT',
  'AD',
  'D ',
  'R ',
  'RM',
  'RT',
  'RD',
  'C ',
  'CM',
  'CT',
  'CD',
  'DD',
  'AU',
  'UD',
  'UA',
  'DU',
  'AA',
  'UU',
  '??',
  '!!',
]);

function parseStatus(value: string | undefined): EGitFileStatus {
  const status = Object.values(EGitFileStatus).find(
    (candidate) => candidate === value,
  );
  if (status === undefined) throw new SyntaxError('Git 状态包含未知字符。');
  return status;
}

/** 解析完整的 git status --porcelain=v1 -z 输出，不修改或规范化路径。 */
export function parseGitStatus(output: string): GitStatusEntry[] {
  if (output.length === 0) return [];
  if (!output.endsWith(NUL))
    throw new SyntaxError('Git 状态输出缺少结束分隔符。');

  const records = output.split(NUL);
  records.pop(); // 最后一个 NUL 分隔产生的空串，不是状态记录。
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (
      record === undefined ||
      record.length <= PATH_OFFSET ||
      record[2] !== FIELD_SEPARATOR ||
      !VALID_STATUS_PAIRS.has(record.slice(0, 2))
    ) {
      throw new SyntaxError('Git 状态记录格式或状态组合不合法。');
    }

    const indexStatus = parseStatus(record[0]);
    const worktreeStatus = parseStatus(record[1]);
    const entry: GitStatusEntry = {
      path: record.slice(PATH_OFFSET),
      indexStatus,
      worktreeStatus,
    };

    const hasOriginalPath = [indexStatus, worktreeStatus].some(
      (status) =>
        status === EGitFileStatus.RENAMED || status === EGitFileStatus.COPIED,
    );
    if (hasOriginalPath) {
      // -z 格式是新路径在前，原路径紧随其后，两者各以 NUL 结束。
      index += 1;
      const originalPath = records[index];
      if (originalPath === undefined || originalPath.length === 0) {
        throw new SyntaxError('Git 重命名或复制记录缺少原路径。');
      }
      entry.originalPath = originalPath;
    }
    entries.push(entry);
  }
  return entries;
}
