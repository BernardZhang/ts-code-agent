import { ingestWorkspaceDocument } from '../bootstrap.js';
import { type IngestDocumentOptions } from '@ts-code-agent/code-agent';

export type IngestDemoOptions = IngestDocumentOptions;

export async function ingestDemo(options: IngestDemoOptions): Promise<void> {
  const { document, chunks } = await ingestWorkspaceDocument(options);

  // 转义文件名和标题中的换行及控制字符，保持每个片段占一行。
  const summary = [
    `${JSON.stringify(document.sourcePath)}：${chunks.length} 个片段`,
    ...chunks.map(
      ({ ordinal, chunkId, startLine, endLine, headingPath }) =>
        `${ordinal + 1}. ${JSON.stringify(chunkId)} L${startLine}-L${endLine} ${JSON.stringify(headingPath)}`,
    ),
  ];
  process.stdout.write(`${summary.join('\n')}\n`);
}
