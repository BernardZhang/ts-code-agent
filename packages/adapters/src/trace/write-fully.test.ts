import { expect, it, vi } from 'vitest';
import { ETraceSinkError, writeFully } from './write-fully.js';

it('短写继续推进输入偏移，直到整批完成', async () => {
  const bytes = new Uint8Array(100);
  const write = vi
    .fn()
    .mockResolvedValueOnce({ bytesWritten: 60 })
    .mockResolvedValueOnce({ bytesWritten: 30 })
    .mockResolvedValueOnce({ bytesWritten: 10 });
  await writeFully({ write }, bytes);
  expect(write.mock.calls).toEqual([
    [bytes, 0, 100, null],
    [bytes, 60, 40, null],
    [bytes, 90, 10, null],
  ]);
});
it.each([0, -1, 101, NaN, 1.5])(
  '非法进度 %s 不进入无限循环',
  async (bytesWritten) => {
    const write = vi.fn().mockResolvedValue({ bytesWritten });
    await expect(
      writeFully({ write }, new Uint8Array(100)),
    ).rejects.toMatchObject({ code: ETraceSinkError.INVALID_WRITE_PROGRESS });
    expect(write).toHaveBeenCalledTimes(1);
  },
);
it('部分成功后异常原样传播，不重试整批', async () => {
  const error = new Error('disk full');
  const write = vi
    .fn()
    .mockResolvedValueOnce({ bytesWritten: 60 })
    .mockRejectedValueOnce(error);
  await expect(writeFully({ write }, new Uint8Array(100))).rejects.toBe(error);
  expect(write).toHaveBeenCalledTimes(2);
});
it('空输入不调用底层写入', async () => {
  const write = vi.fn();
  await writeFully({ write }, new Uint8Array());
  expect(write).not.toHaveBeenCalled();
});
