import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadEnv } from './load-env.js';

const ENV_KEY = 'AGENT_TEST_ENV_VALUE';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'agent-env-'));
  vi.stubEnv(ENV_KEY, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
it('加载 UTF-8 .env，保留引号内的空格与 #', async () => {
  const file = path.join(directory, '.env');
  await writeFile(file, `${ENV_KEY}="本地配置 # value"\n`);
  loadEnv(file);
  expect(process.env[ENV_KEY]).toBe('本地配置 # value');
});
it('已存在的环境变量优先于文件', async () => {
  const file = path.join(directory, '.env');
  await writeFile(file, `${ENV_KEY}=file\n`);
  vi.stubEnv(ENV_KEY, 'shell');
  loadEnv(file);
  expect(process.env[ENV_KEY]).toBe('shell');
});
it('缺少 .env 时继续，其他读取错误明确失败', () => {
  expect(() => loadEnv(path.join(directory, 'missing'))).not.toThrow();
  expect(() => loadEnv(directory)).toThrow('无法读取 .env');
});
