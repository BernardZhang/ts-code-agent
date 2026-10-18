import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';
import { parsePlan } from './commands/structured-demo.js';

describe('configuration and structured output', () => {
  it('uses CLI over environment over defaults', () => {
    const config = readConfig(
      { model: 'cli', think: 'false' },
      {
        AGENT_MODEL: 'env',
        AGENT_CONTEXT_LENGTH: '16384',
        AGENT_THINK: 'true',
      },
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
    ])
      expect(() => readConfig(options, {})).toThrow();
  });
  it('distinguishes JSON errors from schema errors', () => {
    expect(() => parsePlan('bad')).toThrow(
      expect.objectContaining({ code: 'json' }),
    );
    expect(() => parsePlan('{"task":"test","steps":[]}')).toThrow(
      expect.objectContaining({ code: 'validation' }),
    );
    expect(parsePlan('{"task":"test","steps":["read"]}')).toEqual({
      task: 'test',
      steps: ['read'],
    });
  });
});
