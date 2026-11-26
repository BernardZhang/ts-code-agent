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

it('沿用模型和维度默认值，拒绝非法维度和空模型', () => {
  expect(readEmbeddingConfig({}, {})).toMatchObject({
    model: 'embeddinggemma:latest',
    dimensions: 768,
  });
  for (const options of [
    { model: '', dimensions: '768' },
    { model: 'test', dimensions: '0' },
  ]) {
    expect(() => readEmbeddingConfig(options, {})).toThrow();
  }
});
