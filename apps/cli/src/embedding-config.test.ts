import { expect, it } from 'vitest';
import { readEmbeddingConfig } from './embedding-config.js';

it('CLI 覆盖环境配置，保留独立的 Embedding 模型', () => {
  expect(
    readEmbeddingConfig(
      { model: 'chosen', dimensions: '3' },
      {
        AGENT_EMBEDDING_MODEL: 'other',
        AGENT_EMBEDDING_DIMENSIONS: '8',
        AGENT_MODEL: 'chat',
      },
    ),
  ).toMatchObject({ model: 'chosen', dimensions: 3 });
});

it('缺少模型或维度、非法维度均失败', () => {
  for (const options of [
    {},
    { model: 'test' },
    { model: 'test', dimensions: '0' },
  ]) {
    expect(() => readEmbeddingConfig(options, {})).toThrow();
  }
});
