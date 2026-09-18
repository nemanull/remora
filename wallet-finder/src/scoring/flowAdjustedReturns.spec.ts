import type { PortfolioPeriod, PortfolioResponse } from '@remora/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildFlowAdjustedHistory,
  chainReturns,
  computeFlowAdjustedReturns,
  DAY_MS,
  joinCombinedAndPerp,
  type JoinedPoint,
  keepLastPointPerBucket,
  WEEK_MS,
} from './flowAdjustedReturns';

const START = Date.UTC(2025, 9, 6);
const HOUR_MS = 3_600_000;

type Point = [time: number, accountValue: number, pnl: number];

function period(points: Point[], volume = '0'): PortfolioPeriod {
  return {
    accountValueHistory: points.map(([time, value]) => [time, String(value)]),
    pnlHistory: points.map(([time, , pnl]) => [time, String(pnl)]),
    vlm: volume,
  };
}

function joined(
  time: number,
  accountValue: number,
  combinedPnl: number,
  perpPnl = combinedPnl,
): JoinedPoint {
  return { time, accountValue, combinedPnl, perpPnl };
}

function portfolio(windows: {
  month: Point[];
  perpMonth: Point[];
  allTime: Point[];
  perpAllTime: Point[];
}): PortfolioResponse {
  return [
    ['day', period([])],
    ['week', period([])],
    ['month', period(windows.month)],
    ['allTime', period(windows.allTime)],
    ['perpDay', period([])],
    ['perpWeek', period([])],
    ['perpMonth', period(windows.perpMonth)],
    ['perpAllTime', period(windows.perpAllTime)],
  ];
}

describe('computeFlowAdjustedReturns', () => {
  it('counts a deposit in the base from the start of the interval', () => {
    const returns = computeFlowAdjustedReturns([
      joined(START, 100_000, 0, 0),
      joined(START + DAY_MS, 160_000, 10_000, 8_000),
    ]);

    expect(returns).toHaveLength(1);
    expect(returns[0].value).toBeCloseTo(8_000 / 150_000, 12);
  });

  it('keeps a withdrawal in the base until the end of the interval', () => {
    const returns = computeFlowAdjustedReturns([
      joined(START, 200_000, 0),
      joined(START + DAY_MS, 120_000, 20_000),
    ]);

    expect(returns[0].value).toBeCloseTo(0.1, 12);
  });

  it('reads a large withdrawal as a gain when the trading made money', () => {
    const points = [
      joined(START, 1_000_000, 0),
      joined(START + DAY_MS, 300_000, 50_000),
    ];

    const returns = computeFlowAdjustedReturns(points);

    expect(points[1].accountValue / points[0].accountValue - 1).toBeCloseTo(
      -0.7,
      12,
    );
    expect(returns[0].value).toBeCloseTo(0.05, 12);
  });

  it('takes the return from perp PnL and the flows from combined PnL', () => {
    const returns = computeFlowAdjustedReturns([
      joined(START, 100_000, 0, 0),
      joined(START + DAY_MS, 130_000, 30_000, -5_000),
    ]);

    expect(returns[0].value).toBeCloseTo(-0.05, 12);
  });

  it('skips an interval whose base is under 10,000 USD and keeps the next one', () => {
    const returns = computeFlowAdjustedReturns([
      joined(START, 0, 0),
      joined(START + DAY_MS, 5_000, 0),
      joined(START + 2 * DAY_MS, 52_000, 2_000),
    ]);

    expect(returns).toEqual([
      { from: START + DAY_MS, to: START + 2 * DAY_MS, value: 2_000 / 50_000 },
    ]);
  });
});

describe('chainReturns', () => {
  it('compounds the period returns into a time-weighted return', () => {
    expect(chainReturns([0.63, -0.24])).toBeCloseTo(1.63 * 0.76 - 1, 12);
    expect(chainReturns([])).toBe(0);
  });
});

describe('joinCombinedAndPerp', () => {
  it('gives each combined point the perp PnL of the last perp point at or before it', () => {
    const combined = period([
      [START, 100_000, 0],
      [START + DAY_MS, 101_000, 1_000],
      [START + 2 * DAY_MS, 103_000, 3_000],
    ]);
    const perp = period([
      [START - HOUR_MS, 0, 0],
      [START + DAY_MS + HOUR_MS, 0, 900],
      [START + 2 * DAY_MS, 0, 2_500],
    ]);

    expect(
      joinCombinedAndPerp(combined, perp).map((point) => point.perpPnl),
    ).toEqual([0, 0, 2_500]);
  });

  it('drops combined points older than the first perp point', () => {
    const combined = period([
      [START, 100_000, 0],
      [START + DAY_MS, 101_000, 1_000],
    ]);
    const perp = period([[START + HOUR_MS, 0, 0]]);

    expect(joinCombinedAndPerp(combined, perp)).toEqual([
      joined(START + DAY_MS, 101_000, 1_000, 0),
    ]);
  });
});

describe('keepLastPointPerBucket', () => {
  it('keeps the last point of each UTC day and drops empty days', () => {
    const points = [
      joined(START + 6 * HOUR_MS, 100_000, 0),
      joined(START + 18 * HOUR_MS, 100_500, 500),
      joined(START + DAY_MS + 12 * HOUR_MS, 101_000, 1_000),
      joined(START + 3 * DAY_MS, 102_000, 2_000),
    ];

    expect(
      keepLastPointPerBucket(points, DAY_MS).map((point) => point.time),
    ).toEqual([
      START + 18 * HOUR_MS,
      START + DAY_MS + 12 * HOUR_MS,
      START + 3 * DAY_MS,
    ]);
  });
});

describe('buildFlowAdjustedHistory', () => {
  it('keeps a biweekly allTime history biweekly instead of inventing weeks', () => {
    const allTime: Point[] = Array.from({ length: 30 }, (_, index) => [
      START + index * 2 * WEEK_MS,
      100_000 + index * 1_000,
      index * 1_000,
    ]);

    const history = buildFlowAdjustedHistory(
      portfolio({
        month: [],
        perpMonth: [],
        allTime,
        perpAllTime: allTime,
      }),
    );

    expect(history.weeklyReturns).toHaveLength(29);
    expect(history.weeklyReturns[0]).toEqual({
      from: START,
      to: START + 2 * WEEK_MS,
      value: 1_000 / 100_000,
    });
    expect(history.firstPointAt).toBe(START);
    expect(history.lastPointAt).toBe(START + 58 * WEEK_MS);
  });

  it('resamples the month window to days and the allTime window to weeks', () => {
    const hourly: Point[] = Array.from({ length: 72 }, (_, index) => [
      START + index * HOUR_MS,
      50_000 + index * 10,
      index * 10,
    ]);

    const history = buildFlowAdjustedHistory(
      portfolio({
        month: hourly,
        perpMonth: hourly,
        allTime: hourly,
        perpAllTime: hourly,
      }),
    );

    expect(history.dailyReturns).toHaveLength(2);
    expect(history.dailyReturns[0]).toMatchObject({
      from: START + 23 * HOUR_MS,
      to: START + 47 * HOUR_MS,
    });
    expect(history.weeklyReturns).toHaveLength(0);
  });

  it('fails on a portfolio without the windows it needs', () => {
    expect(() => buildFlowAdjustedHistory([['day', period([])]])).toThrow(
      'The portfolio has no allTime window',
    );
  });
});
