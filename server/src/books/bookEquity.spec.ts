import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  markBook,
  type MarkedCopy,
  measureCumulativePnl,
  measureNetPnl,
  measureNotionalUsd,
  measurePaperEquity,
  measureUnrealizedPnl,
  startOfUtcDay,
} from './bookEquity';

function marked(overrides: Partial<MarkedCopy> = {}): MarkedCopy {
  return {
    coin: 'ETH',
    size: new Decimal('1.5'),
    entryPx: new Decimal(3_000),
    mark: new Decimal(3_100),
    leverage: 5,
    ...overrides,
  };
}

describe('startOfUtcDay', () => {
  it('returns midnight UTC of the same day', () => {
    expect(
      startOfUtcDay(new Date('2026-04-20T23:59:59.999Z')).toISOString(),
    ).toBe('2026-04-20T00:00:00.000Z');
  });
});

describe('measureNetPnl', () => {
  it('nets realized PnL with fees and signed funding', () => {
    expect(
      measureNetPnl({
        realizedPnl: new Decimal(120),
        feesUsd: new Decimal('4.5'),
        fundingUsd: new Decimal('-2.25'),
      }).toFixed(),
    ).toBe('113.25');
  });
});

describe('measureUnrealizedPnl', () => {
  it('gains on a long when the mark rises', () => {
    expect(measureUnrealizedPnl(marked()).toFixed()).toBe('150');
  });

  it('loses on a short when the mark rises', () => {
    expect(
      measureUnrealizedPnl(marked({ size: new Decimal('-2') })).toFixed(),
    ).toBe('-200');
  });

  it('is zero without an entry price or a mark', () => {
    expect(measureUnrealizedPnl(marked({ entryPx: null })).toFixed()).toBe('0');
    expect(measureUnrealizedPnl(marked({ mark: null })).toFixed()).toBe('0');
  });
});

describe('measureNotionalUsd', () => {
  it('marks the absolute size at the mark and falls back to the entry', () => {
    expect(
      measureNotionalUsd(marked({ size: new Decimal(-1) })).toFixed(),
    ).toBe('3100');
    expect(measureNotionalUsd(marked({ mark: null })).toFixed()).toBe('4500');
  });
});

describe('markBook', () => {
  it('sums unrealized PnL, gross exposure and initial margin', () => {
    const book = markBook([
      marked(),
      marked({
        coin: 'BTC',
        size: new Decimal('-0.1'),
        entryPx: new Decimal(60_000),
        mark: new Decimal(61_000),
        leverage: 4,
      }),
    ]);
    expect(book.unrealizedPnl.toFixed()).toBe('50');
    expect(book.grossExposureUsd.toFixed()).toBe('10750');
    expect(book.initialMarginUsd.toFixed()).toBe('2455');
  });
});

describe('measureCumulativePnl', () => {
  it('adds unrealized PnL to the net PnL without any base', () => {
    expect(
      measureCumulativePnl({
        netPnlUsd: new Decimal('-40.25'),
        unrealizedPnl: new Decimal('100'),
      }).toFixed(),
    ).toBe('59.75');
  });
});

describe('measurePaperEquity', () => {
  it('adds net PnL and unrealized PnL to the starting equity', () => {
    expect(
      measurePaperEquity({
        startingEquityUsd: new Decimal(25_000),
        netPnlUsd: new Decimal('-310.5'),
        unrealizedPnl: new Decimal('42.25'),
      }).toFixed(),
    ).toBe('24731.75');
  });
});
