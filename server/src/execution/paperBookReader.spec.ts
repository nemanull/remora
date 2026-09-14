import type { HyperliquidInfoClient, L2BookResponse } from '@remora/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsService } from '../metrics/metrics.service';
import { BOOK_REUSE_MS, PaperBookReader } from './paperBookReader';

const START = Date.parse('2026-04-20T12:00:00.000Z');

function bookResponse(bid: string): L2BookResponse {
  return {
    coin: 'ETH',
    time: START,
    levels: [[{ px: bid, sz: '2', n: 1 }], [{ px: '3101', sz: '2', n: 1 }]],
  };
}

function createReader() {
  let release: (response: L2BookResponse) => void = () => {};
  const l2Book = vi.fn(
    () =>
      new Promise<L2BookResponse>((resolve) => {
        release = resolve;
      }),
  );
  const reader = new PaperBookReader(
    { l2Book } as unknown as HyperliquidInfoClient,
    new MetricsService(),
  );
  return {
    reader,
    l2Book,
    respond: (bid: string) => release(bookResponse(bid)),
  };
}

describe('PaperBookReader', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares one request among concurrent reads of a coin', async () => {
    const { reader, l2Book, respond } = createReader();
    const first = reader.readBook('ETH', START);
    vi.setSystemTime(START + 2_000);
    const second = reader.readBook('ETH', START);
    respond('3100');
    const [firstBook, secondBook] = await Promise.all([first, second]);
    expect(l2Book).toHaveBeenCalledTimes(1);
    expect(secondBook).toBe(firstBook);
  });

  it(`reuses a book read within the last ${BOOK_REUSE_MS} ms and reads again after that`, async () => {
    const { reader, l2Book, respond } = createReader();
    const first = reader.readBook('ETH', START);
    respond('3100');
    await first;
    vi.setSystemTime(START + BOOK_REUSE_MS);
    await reader.readBook('ETH', START);
    expect(l2Book).toHaveBeenCalledTimes(1);
    vi.setSystemTime(START + BOOK_REUSE_MS + 1);
    const later = reader.readBook('ETH', START);
    respond('3090');
    expect((await later).bids[0].price.toFixed()).toBe('3090');
    expect(l2Book).toHaveBeenCalledTimes(2);
  });

  it('never hands out a book read before the order started waiting', async () => {
    const { reader, l2Book, respond } = createReader();
    const early = reader.readBook('ETH', START);
    respond('3100');
    await early;
    vi.setSystemTime(START + 100);
    const fresh = reader.readBook('ETH', START + 50);
    respond('3095');
    expect((await fresh).bids[0].price.toFixed()).toBe('3095');
    expect(l2Book).toHaveBeenCalledTimes(2);
  });

  it('keeps every coin apart and forgets a failed read', async () => {
    const l2Book = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(bookResponse('3100'));
    const reader = new PaperBookReader(
      { l2Book } as unknown as HyperliquidInfoClient,
      new MetricsService(),
    );
    await expect(reader.readBook('ETH', START)).rejects.toThrow('timeout');
    await reader.readBook('ETH', START);
    await reader.readBook('BTC', START);
    expect(l2Book.mock.calls.map(([coin]) => coin as string)).toEqual([
      'ETH',
      'ETH',
      'BTC',
    ]);
  });
});
