import { describe, expect, it } from 'vitest';
import { parseDocument } from './parse-document.js';
import { EDocumentFormat } from './types.js';

describe('parseDocument', () => {
  it('识别标题层级，围栏中的 # 保持在正文里', () => {
    const fence = '~'.repeat(3);
    const text = [
      '# 一级',
      '## 二级',
      fence,
      '# 示例代码',
      fence,
      '## 同级',
      '正文',
    ].join('\n');
    const sections = parseDocument(text, EDocumentFormat.MARKDOWN);
    const sectionText = ({
      startOffset,
      endOffset,
    }: (typeof sections)[number]) => text.slice(startOffset, endOffset);

    expect(
      sections.find((section) => sectionText(section).includes('# 示例代码')),
    ).toMatchObject({ headingPath: ['一级', '二级'] });
    expect(
      sections.find((section) => sectionText(section).includes('正文')),
    ).toMatchObject({ headingPath: ['一级', '同级'] });
  });

  it('TXT 的 # 是正文，空行划分段落', () => {
    const text = '# 第一段\n\n第二段';
    const sections = parseDocument(text, EDocumentFormat.TEXT);

    expect(
      sections.map(({ startOffset, endOffset, headingPath }) => ({
        text: text.slice(startOffset, endOffset).trim(),
        headingPath,
      })),
    ).toEqual([
      { text: '# 第一段', headingPath: [] },
      { text: '第二段', headingPath: [] },
    ]);
  });

  it('保留围栏内空行，只有同类且足够长的标记能关闭围栏', () => {
    const fence = String.fromCharCode(96).repeat(4);
    const code = [
      fence + 'ts',
      '',
      fence.slice(1),
      '~~~~',
      '## 仍在围栏内',
      fence,
    ].join('\n');
    const text = ['😀 前言', '', '# 章节 ###', code, '## 小节', '正文'].join(
      '\n',
    );

    expect(
      parseDocument(text, EDocumentFormat.MARKDOWN).map(
        ({ startOffset, endOffset, headingPath }) => ({
          startOffset,
          text: text.slice(startOffset, endOffset),
          headingPath,
        }),
      ),
    ).toEqual([
      { startOffset: 0, text: '😀 前言', headingPath: [] },
      {
        startOffset: text.indexOf('# 章节'),
        text: '# 章节 ###\n' + code,
        headingPath: ['章节'],
      },
      {
        startOffset: text.indexOf('## 小节'),
        text: '## 小节\n正文',
        headingPath: ['章节', '小节'],
      },
    ]);
  });
});
