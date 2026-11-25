import { afterEach, expect, it, vi } from 'vitest';
import { ModelError, ModelErrorCode } from '@ts-code-agent/core';
import { createVectorStore } from './vector-demo.js';

afterEach(() => vi.unstubAllEnvs());
const config = {
  baseUrl: 'http://127.0.0.1:11434',
  model: 'embeddinggemma',
  dimensions: 768,
  timeoutMs: 120000,
};

it.each([undefined, '', 'https://user:secret@example.test/db'])(
  '数据库配置 %j 非法时提示变量名且不暴露密码',
  (value) => {
    vi.stubEnv('AGENT_DATABASE_URL', value);
    try {
      createVectorStore(config);
      throw new Error('预期拒绝非法配置');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      expect(error).toMatchObject({ code: ModelErrorCode.VALIDATION });
      expect(String(error)).toContain('AGENT_DATABASE_URL');
      expect(String(error)).not.toContain('secret');
    }
  },
);
