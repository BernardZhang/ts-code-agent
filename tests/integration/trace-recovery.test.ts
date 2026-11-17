import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  ETraceReadDiagnostic,
  ETraceReadItemType,
  readTrace,
} from '@ts-code-agent/adapters';

it('recovers flushed metadata after a writer process is killed without close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trace-recovery-'));
  const path = join(directory, 'run.jsonl');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { BatchTraceWriter, FileTraceSink } from '@ts-code-agent/adapters';
    import { EAgentEventType } from '@ts-code-agent/core';
    const writer = new BatchTraceWriter(await FileTraceSink.open(process.argv[1]));
    writer.enqueue({ schemaVersion: 1, sequence: 1, runId: 'killed-run', elapsedMs: 0, type: EAgentEventType.RUN_STARTED });
    writer.enqueue({ schemaVersion: 1, sequence: 2, runId: 'killed-run', elapsedMs: 1, type: EAgentEventType.TEXT_DELTA, step: 1 });
    await writer.flush();
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([bytes]) => String(bytes)),
      exited.then(() => {
        throw new Error('Writer exited before ready');
      }),
    ]);
    expect(ready).toBe('ready');
    child.kill('SIGKILL');
    expect((await exited)[1]).toBe('SIGKILL');
    const items = [];
    for await (const item of readTrace(path)) {
      items.push(item);
    }
    expect(
      items.filter((item) => item.type === ETraceReadItemType.RECORD),
    ).toHaveLength(2);
    for (const code of [
      ETraceReadDiagnostic.MISSING_FOOTER,
      ETraceReadDiagnostic.MISSING_RUN_FINISHED,
    ]) {
      expect(items).toContainEqual(expect.objectContaining({ code }));
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
});
