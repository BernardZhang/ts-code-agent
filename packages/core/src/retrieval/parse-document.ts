import { EDocumentFormat, type DocumentSection } from './types.js';

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*)|$)/u;
const CLOSING_HEADING_MARKS = /(?:^|[ \t])#+$/u;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/u;

interface Heading {
  readonly level: number;
  readonly title: string;
}

/**
 * 从已规范化的正文识别结构区段，区段保留原文的 UTF-16 偏移。
 * Markdown 标题更新当前层级，代码围栏内的空行和井号属于正文。
 * TXT 以空行识别段落。
 */
export function parseDocument(
  text: string,
  format: EDocumentFormat,
): readonly DocumentSection[] {
  const sections: DocumentSection[] = [];
  const headings: Heading[] = [];
  let openFence: string | undefined;
  let sectionStart: number | undefined;
  let sectionEnd = 0;

  const finishSection = () => {
    if (sectionStart !== undefined) {
      sections.push({
        startOffset: sectionStart,
        endOffset: sectionEnd,
        headingPath: headings.map(({ title }) => title),
      });
      sectionStart = undefined;
    }
  };

  // 按行扫描原文，保留区段内部换行，分隔段落的空白留在区段之外。
  for (let offset = 0; offset < text.length; ) {
    const start = offset;
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    offset = end + 1;

    const insideFence = openFence !== undefined;
    if (format === EDocumentFormat.MARKDOWN) {
      const [, marker, info = ''] = CODE_FENCE.exec(line) ?? [];
      if (openFence !== undefined) {
        // 关闭围栏须使用相同字符，长度至少等于开围栏，后面只允许空格或 tab。
        if (marker?.startsWith(openFence) && /^[ \t]*$/u.test(info)) {
          openFence = undefined;
        }
      } else if (marker && (!marker.startsWith('`') || !info.includes('`'))) {
        openFence = marker;
      } else {
        const [, hashes, title = ''] = ATX_HEADING.exec(line) ?? [];
        if (hashes) {
          finishSection();
          while ((headings.at(-1)?.level ?? 0) >= hashes.length) {
            headings.pop();
          }
          headings.push({
            level: hashes.length,
            title: title.trimEnd().replace(CLOSING_HEADING_MARKS, '').trim(),
          });
        }
      }
    }

    if (!insideFence && !line.trim()) {
      finishSection();
      continue;
    }
    sectionStart ??= start;
    sectionEnd = end;
  }

  finishSection();
  return sections;
}
