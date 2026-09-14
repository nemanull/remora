import type { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config';
import type { OrderBook } from '../market/marketData.service';
import type { PaperBookReader } from './paperBookReader';
import { fillFromBook, PaperExecutor } from './paperExecutor';
import type { OrderRequest } from './types';

const ACKNOWLEDGED_AT = new Date('2026-04-20T12:00:01.000Z');

function level(price: string, size: string) {
  return { price: new Decimal(price), size: new Decimal(size) };
}

const BOOK: OrderBook = {
  coin: 'ETH',
  time: new Date('2026-04-20T12:00:00.900Z'),
  bids: [level('3099', '0.6'), level('3098', '0.6'), level('3000', '10')],
  asks: [level('3100', '1'), level('3105', '1'), level('3200', '5')],
};

function order(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    cloid: '0x0123456789abcdef0123456789abcdef',
    coin: 'ETH',
    isBuy: true,
    size: new Decimal(3),
    limitPx: new Decimal(3_110),
    reduceOnly: false,
    heldSize: new Decimal(0),
    ...overrides,
  };
}

describe('fillFromBook', () => {
  it('fills partially up to the limit price at the walked VWAP', () => {
    const result = fillFromBook(order(), BOOK, 4.5, ACKNOWLEDGED_AT);
    expect(result.status).toBe('PARTIALLY_FILLED');
    expect(result.filledSize.toFixed()).toBe('2');
    expect(result.averagePrice?.toFixed()).toBe('3102.5');
    expect(result.feeUsd.toFixed()).toBe('2.79225');
    expect(result.acknowledgedAt).toBe(ACKNOWLEDGED_AT);
  });

  it('clips a reduce-only close to the size the copy holds', () => {
    const result = fillFromBook(
      order({
        isBuy: false,
        size: new Decimal('1.5'),
        limitPx: new Decimal(3_000),
        reduceOnly: true,
        heldSize: new Decimal('-1'),
      }),
      BOOK,
      4.5,
      ACKNOWLEDGED_AT,
    );
    expect(result.status).toBe('FILLED');
    expect(result.filledSize.toFixed()).toBe('1');
    expect(result.averagePrice?.toFixed()).toBe('3098.6');
  });

  it('reports an IOC that finds nothing inside its limit as unfilled', () => {
    const result = fillFromBook(
      order({ limitPx: new Decimal(3_050) }),
      BOOK,
      4.5,
      ACKNOWLEDGED_AT,
    );
    expect(result).toMatchObject({
      status: 'UNFILLED',
      error: 'ioc_unfilled',
      averagePrice: null,
    });
    expect(result.feeUsd.toFixed()).toBe('0');
  });
});

describe('PaperExecutor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function createExecutor(
    readBook: (coin: string, notBefore: number) => Promise<OrderBook>,
    latencyMs = 0,
  ) {
    const books = { readBook } as unknown as PaperBookReader;
    const values: Record<string, number> = {
      PAPER_ORDER_LATENCY_MS: latencyMs,
      TAKER_FEE_BPS: 4.5,
    };
    const config = {
      getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService<ServerConfig, true>;
    return new PaperExecutor(books, config);
  }

  it('fills against the book it reads after the latency', async () => {
    const executor = createExecutor(() => Promise.resolve(BOOK));
    const result = await executor.execute(order({ size: new Decimal(1) }));
    expect(result.status).toBe('FILLED');
    expect(result.averagePrice?.toFixed()).toBe('3100');
  });

  it('reads the book only once the latency has passed, and never one from before the wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T12:00:00.000Z'));
    const readBook = vi.fn(() => Promise.resolve(BOOK));
    const executor = createExecutor(readBook, 900);
    const pending = executor.execute(order({ size: new Decimal(1) }));
    await vi.advanceTimersByTimeAsync(899);
    expect(readBook).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(readBook).toHaveBeenCalledWith(
      'ETH',
      Date.parse('2026-04-20T12:00:00.000Z'),
    );
  });

  it('rejects the order when the book cannot be read', async () => {
    const executor = createExecutor(() =>
      Promise.reject(new Error('Hyperliquid rate limited the l2Book request')),
    );
    const result = await executor.execute(order());
    expect(result.status).toBe('REJECTED');
    expect(result.error).toContain('book_unavailable');
  });
});
