import { describe, expect, it } from 'vitest';
import {
  countRecentLiquidations,
  LIQUIDATION_LOOKBACK_MS,
} from './liquidations';

const AS_OF = Date.UTC(2026, 4, 1);

describe('countRecentLiquidations', () => {
  it('counts liquidation entries of the last 30 days only', () => {
    const entries = [
      {
        time: AS_OF - LIQUIDATION_LOOKBACK_MS - 1,
        delta: { type: 'liquidation' },
      },
      { time: AS_OF - LIQUIDATION_LOOKBACK_MS, delta: { type: 'liquidation' } },
      { time: AS_OF - 3_600_000, delta: { type: 'liquidation' } },
      { time: AS_OF - 3_600_000, delta: { type: 'deposit' } },
    ];

    expect(countRecentLiquidations(entries, AS_OF)).toBe(2);
  });

  it('finds nothing in a ledger of deposits and transfers', () => {
    const entries = [
      { time: AS_OF - 1_000, delta: { type: 'deposit' } },
      { time: AS_OF - 2_000, delta: { type: 'internalTransfer' } },
    ];

    expect(countRecentLiquidations(entries, AS_OF)).toBe(0);
  });
});
