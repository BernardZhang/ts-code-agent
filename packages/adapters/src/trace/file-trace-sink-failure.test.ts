import { beforeEach, expect, it, vi } from 'vitest';
import { FileTraceSink } from './file-trace-sink.js';
import { ETraceSinkError } from './write-fully.js';

const io = vi.hoisted(() => ({
  open: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ open: io.open }));
beforeEach(() => {
  vi.resetAllMocks();
  io.open.mockResolvedValue({ write: io.write, close: io.close });
  io.close.mockResolvedValue(undefined);
});
it('打开失败原样传播，不关闭未取得的句柄', async () => {
  const error = new Error('open failed');
  io.open.mockRejectedValue(error);
  await expect(FileTraceSink.open('run.jsonl')).rejects.toBe(error);
  expect(io.close).not.toHaveBeenCalled();
});
it('写入失败后禁止继续写，但仍然关闭资源', async () => {
  const error = new Error('disk full');
  io.write
    .mockResolvedValueOnce({ bytesWritten: 1 })
    .mockRejectedValueOnce(error);
  const sink = await FileTraceSink.open('run.jsonl');
  await expect(sink.write(new Uint8Array(2))).rejects.toBe(error);
  await expect(sink.write(new Uint8Array(1))).rejects.toMatchObject({
    code: ETraceSinkError.NOT_WRITABLE,
  });
  expect(io.write).toHaveBeenCalledTimes(2);
  await sink.close();
  expect(io.close).toHaveBeenCalledTimes(1);
});
it('关闭失败后不重试关闭，不恢复写入', async () => {
  const error = new Error('close failed');
  io.close.mockRejectedValue(error);
  const sink = await FileTraceSink.open('run.jsonl');
  const closing = sink.close();
  await expect(closing).rejects.toBe(error);
  expect(sink.close()).toBe(closing);
  await expect(sink.write(new Uint8Array(1))).rejects.toMatchObject({
    code: ETraceSinkError.NOT_WRITABLE,
  });
  expect(io.close).toHaveBeenCalledTimes(1);
  expect(io.write).not.toHaveBeenCalled();
});
