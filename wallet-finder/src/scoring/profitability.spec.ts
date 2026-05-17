import type { HyperliquidWsFill } from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeScore, computeWalletStats, rankByScore } from './profitability';

function makeFill(
  dir: string,
  closedPnl: string,
  fee: string,
): HyperliquidWsFill {
  return {
    coin: 'XRP',
    px: '1.5',
    sz: '10.0',
    side: 'B',
    time: 1770000000000,
    startPosition: '0.0',
    dir,
    closedPnl,
    hash: '0x1',
    oid: 1,
    crossed: true,
    fee,
    tid: 1,
    feeToken: 'USDC',
  };
}

describe('profitability', () => {
  it('counts closes and wins', () => {
    const stats = computeWalletStats(
      '0xabc',
      [
        makeFill('Open Long', '0.0', '0.01'),
        makeFill('Close Long', '2.0', '0.01'),
        makeFill('Open Short', '0.0', '0.01'),
        makeFill('Close Short', '-1.0', '0.01'),
      ],
      new Decimal(100),
    );

    expect(stats.fills).toBe(4);
    expect(stats.closes).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.winRate).toBe(0.5);
    expect(stats.netPnl.toString()).toBe('0.96');
    expect(stats.roi.toString()).toBe('0.0096');
    expect(stats.volume.toString()).toBe('60');
  });

  it('gives zero roi without account value', () => {
    const stats = computeWalletStats(
      '0xabc',
      [makeFill('Close Long', '2.0', '0.01')],
      new Decimal(0),
    );

    expect(stats.roi.isZero()).toBe(true);
  });

  it('adds fees without float error', () => {
    const stats = computeWalletStats(
      '0xabc',
      [
        makeFill('Open Long', '0.0', '0.1'),
        makeFill('Close Long', '1.0', '0.2'),
      ],
      new Decimal(100),
    );

    expect(stats.fees.toString()).toBe('0.3');
    expect(stats.netPnl.toString()).toBe('0.7');
  });

  it('keeps the score between 0 and 1', () => {
    const stats = computeWalletStats(
      '0xabc',
      [makeFill('Close Long', '500.0', '0.01')],
      new Decimal(100),
    );

    expect(computeScore(stats)).toBeLessThanOrEqual(1);
    expect(computeScore(stats)).toBeGreaterThan(0);
  });

  it('ranks the better wallet first', () => {
    const winner = computeWalletStats(
      '0xaaa',
      [makeFill('Close Long', '2.0', '0.01')],
      new Decimal(100),
    );
    const loser = computeWalletStats(
      '0xbbb',
      [makeFill('Close Long', '-2.0', '0.01')],
      new Decimal(100),
    );

    const ranked = rankByScore([loser, winner]);

    expect(ranked.map((row) => row.wallet)).toEqual(['0xaaa', '0xbbb']);
  });
});
