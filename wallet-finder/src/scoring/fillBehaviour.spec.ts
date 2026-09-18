import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyMarket,
  measureCoveredWindow,
  measureFillBehaviour,
  type ScoredFill,
} from './fillBehaviour';

const START = Date.UTC(2026, 3, 1);
const MINUTE_MS = 60_000;

function fill(
  minute: number,
  overrides: Partial<ScoredFill> & Pick<ScoredFill, 'side' | 'sz' | 'px'>,
): ScoredFill {
  return {
    coin: 'BTC',
    time: START + minute * MINUTE_MS,
    startPosition: '0',
    oid: minute,
    crossed: true,
    tid: minute,
    ...overrides,
  };
}

const TEN_HOURS = { from: START, to: START + 600 * MINUTE_MS };

const mixedFills: ScoredFill[] = [
  fill(60, { side: 'B', sz: '1', px: '100' }),
  fill(180, { side: 'A', sz: '1', px: '110', startPosition: '1' }),
  fill(300, {
    coin: 'ETH',
    side: 'B',
    sz: '1',
    px: '50',
    startPosition: '2',
    crossed: false,
  }),
  fill(400, { coin: 'ETH', side: 'A', sz: '5', px: '60', startPosition: '3' }),
  fill(450, { coin: 'xyz:MU', side: 'B', sz: '14', px: '10' }),
  fill(500, { coin: '@107', side: 'B', sz: '1000', px: '80' }),
];

describe('classifyMarket', () => {
  it.each([
    ['BTC', 'main_perp'],
    ['kPEPE', 'main_perp'],
    ['xyz:MU', 'builder_perp'],
    ['@107', 'other'],
    ['PURR/USDC', 'other'],
    ['#1234', 'other'],
  ])('classifies %s as %s', (coin, kind) => {
    expect(classifyMarket(coin)).toBe(kind);
  });
});

describe('measureFillBehaviour', () => {
  it('measures the hold as time-weighted open notional over newly opened notional', () => {
    const behaviour = measureFillBehaviour(mixedFills.slice(0, 2), TEN_HOURS);

    expect(behaviour.holdMinutes).toBeCloseTo((1 * 100 * 120) / 100, 9);
  });

  it('carries positions held before the window and counts a flip as a new open', () => {
    const heldNotionalMinutes =
      100 * 120 + 2 * 50 * 300 + 3 * 50 * 100 + 2 * 60 * 200;
    const openedNotional = 100 + 50 + 2 * 60;

    const behaviour = measureFillBehaviour(mixedFills, TEN_HOURS);

    expect(behaviour.holdMinutes).toBeCloseTo(
      heldNotionalMinutes / openedNotional,
      9,
    );
  });

  it('counts perp orders per day and main-dex orders per week', () => {
    const behaviour = measureFillBehaviour(mixedFills, TEN_HOURS);

    expect(behaviour.ordersPerDay).toBeCloseTo(5 / (600 / 1_440), 9);
    expect(behaviour.copyableOrdersPerWeek).toBeCloseTo(4 / (600 / 10_080), 9);
  });

  it('weights the maker share and the main-dex share by notional', () => {
    const behaviour = measureFillBehaviour(mixedFills, TEN_HOURS);

    expect(behaviour.makerShare).toBeCloseTo(50 / 560, 12);
    expect(behaviour.coreNotionalShare).toBeCloseTo(560 / 700, 12);
  });

  it('counts the many fills of one taker order as one order', () => {
    const sweep = ['0.39129', '0.0943', '0.19564'].map((size, index) =>
      fill(10, {
        side: 'B',
        sz: size,
        px: '85154',
        oid: 551583362789,
        tid: 236558987004128 - index,
      }),
    );

    const behaviour = measureFillBehaviour(sweep, TEN_HOURS);

    expect(behaviour.ordersPerDay).toBeCloseTo(1 / (600 / 1_440), 9);
  });

  it('reports no hold and no shares for a wallet without perp fills', () => {
    const behaviour = measureFillBehaviour([mixedFills[5]], TEN_HOURS);

    expect(behaviour).toEqual({
      holdMinutes: null,
      ordersPerDay: 0,
      copyableOrdersPerWeek: 0,
      makerShare: null,
      coreNotionalShare: null,
    });
  });

  it('finds the minute holds of the dev wallet scalps', () => {
    const snapshot = JSON.parse(
      readFileSync(
        join(__dirname, '../../../payloads/userFills/snapshot.json'),
        'utf8',
      ),
    ) as { data: { fills: ScoredFill[] } };
    const fills = snapshot.data.fills;

    const behaviour = measureFillBehaviour(fills, {
      from: fills[0].time,
      to: fills[fills.length - 1].time,
    });

    expect(behaviour.holdMinutes).toBeGreaterThan(0);
    expect(behaviour.holdMinutes).toBeLessThan(60);
    expect(behaviour.coreNotionalShare).toBe(1);
    expect(behaviour.makerShare).toBe(0);
  });
});

describe('measureCoveredWindow', () => {
  const requested = { from: START, to: START + 30 * 1_440 * MINUTE_MS };
  const fills = [
    fill(1_000, { side: 'B', sz: '1', px: '1' }),
    fill(2_000, { side: 'A', sz: '1', px: '1', startPosition: '1' }),
  ];

  it('covers the requested window when every page fit', () => {
    expect(
      measureCoveredWindow(
        { fills, firstPageFull: false, reachedPageLimit: false },
        requested,
      ),
    ).toEqual(requested);
  });

  it('starts at the first fill when the first page was full, since older fills may be out of reach', () => {
    expect(
      measureCoveredWindow(
        { fills, firstPageFull: true, reachedPageLimit: false },
        requested,
      ),
    ).toEqual({ from: fills[0].time, to: requested.to });
  });

  it('ends at the last fill read when the page limit cut the reading short', () => {
    expect(
      measureCoveredWindow(
        { fills, firstPageFull: true, reachedPageLimit: true },
        requested,
      ),
    ).toEqual({ from: fills[0].time, to: fills[1].time });
  });
});
