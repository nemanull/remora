import { describe, expect, it } from 'vitest';
import {
  type ClosedCopy,
  countNegativeWeeksInRow,
  measureStreamRejectionShare,
  summarizeClosedCopies,
} from './shadowStats';

const NOW = new Date('2026-04-20T02:30:00.000Z');
const DAY_MS = 86_400_000;

function closed(
  daysAgo: number,
  realizedPnl: number,
  feesUsd = 0,
  fundingUsd = 0,
): ClosedCopy {
  return {
    closedAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
    realizedPnl,
    feesUsd,
    fundingUsd,
  };
}

describe('summarizeClosedCopies', () => {
  it('nets fees out and funding in, and divides by the allocation', () => {
    const results = summarizeClosedCopies(
      [closed(3, 120, 4.5, -2), closed(1, 80, 3, 1.5)],
      5_000,
    );

    expect(results.closedCopies).toBe(2);
    expect(results.netPnlUsd).toBeCloseTo(192, 12);
    expect(results.returnOnAllocation).toBeCloseTo(192 / 5_000, 12);
  });

  it('measures the drawdown of the realized curve in order of closing', () => {
    const results = summarizeClosedCopies(
      [closed(1, 300), closed(5, 200), closed(4, -350), closed(3, -100)],
      5_000,
    );

    expect(results.netPnlUsd).toBe(50);
    expect(results.maxDrawdown).toBeCloseTo(-450 / 5_000, 12);
  });

  it('counts a loss from the start as a drawdown', () => {
    expect(summarizeClosedCopies([closed(2, -600)], 5_000).maxDrawdown).toBe(
      -0.12,
    );
  });

  it('reports a flat curve for no copies', () => {
    expect(summarizeClosedCopies([], 5_000)).toEqual({
      closedCopies: 0,
      netPnlUsd: 0,
      returnOnAllocation: 0,
      maxDrawdown: 0,
    });
  });
});

describe('measureStreamRejectionShare', () => {
  it('shares stale and drifted entries among the entries that reached those checks', () => {
    expect(
      measureStreamRejectionShare([
        { reason: 'opened', count: 6 },
        { reason: 'stale_signal', count: 3 },
        { reason: 'price_drift', count: 1 },
        { reason: 'cap_reached', count: 2 },
        { reason: 'below_min_notional', count: 9 },
        { reason: 'position_not_copied', count: 4 },
        { reason: 'already_at_target', count: 2 },
      ]),
    ).toBeCloseTo(4 / 12, 12);
  });

  it('has no share without a counted entry', () => {
    expect(
      measureStreamRejectionShare([{ reason: 'below_min_notional', count: 3 }]),
    ).toBeNull();
    expect(measureStreamRejectionShare([])).toBeNull();
  });
});

describe('countNegativeWeeksInRow', () => {
  const liveSince = new Date(NOW.getTime() - 40 * DAY_MS);

  it('counts the losing weeks that end now', () => {
    const copies = [
      closed(2, -50),
      closed(9, -20),
      closed(16, 30, 40),
      closed(23, 500),
    ];

    expect(countNegativeWeeksInRow(copies, liveSince, NOW)).toBe(3);
  });

  it('stops at a week that made money or traded nothing', () => {
    expect(
      countNegativeWeeksInRow(
        [closed(2, -50), closed(16, -10), closed(23, -10)],
        liveSince,
        NOW,
      ),
    ).toBe(1);
    expect(
      countNegativeWeeksInRow([closed(2, -50), closed(9, 80)], liveSince, NOW),
    ).toBe(1);
  });

  it('only counts full weeks since the wallet went live', () => {
    const copies = [closed(2, -50), closed(9, -20), closed(16, -30)];

    expect(
      countNegativeWeeksInRow(
        copies,
        new Date(NOW.getTime() - 20 * DAY_MS),
        NOW,
      ),
    ).toBe(2);
  });
});
