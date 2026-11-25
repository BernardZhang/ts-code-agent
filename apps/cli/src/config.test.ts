import { ModelErrorCode } from '@ts-code-agent/core';
import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';
import { parsePlan } from './commands/structured-demo.js';

const configEnvironment = {
  AGENT_BASE_URL: 'http://127.0.0.1:11434',
  AGENT_MODEL: 'env',
  AGENT_CONTEXT_LENGTH: '16384',
  AGENT_TIMEOUT_MS: '120000',
  AGENT_THINK: 'true',
};

describe('configuration and structured output', () => {
  it('uses CLI over explicitly configured environment', () => {
    const config = readConfig(
      { model: 'cli', think: 'false' },
      configEnvironment,
    );
    expect(config).toMatchObject({
      model: 'cli',
      contextLength: 16384,
      think: false,
      timeoutMs: 120000,
    });
  });
  it('rejects invalid booleans, numbers and URLs', () => {
    for (const options of [
      { think: 'yes' },
      { timeoutMs: '0' },
      { contextLength: 'oops' },
      { baseUrl: 'file:///tmp' },
    ]) {
      expect(() => readConfig(options, configEnvironment)).toThrow();
    }
  });
  it('distinguishes JSON errors from schema errors', () => {
    expect(() => parsePlan('bad')).toThrow(
      expect.objectContaining({ code: ModelErrorCode.JSON }),
    );
    expect(() => parsePlan('{"task":"test","steps":[]}')).toThrow(
      expect.objectContaining({ code: ModelErrorCode.VALIDATION }),
    );
    expect(parsePlan('{"task":"test","steps":["read"]}')).toEqual({
      task: 'test',
      steps: ['read'],
    });
  });
});
