import type { ConfigService } from '@nestjs/config';
import type {
  HyperliquidInfoClient,
  PortfolioPeriod,
  PortfolioResponse,
} from '@remora/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { WalletFinderConfig } from '../config';
import type { StageTwoTarget } from '../discovery/stageOne';
import type { LeaderboardRow } from '../discovery/statsDataFiles';
import type { ScoredFill } from './fillBehaviour';
import { DAY_MS, WEEK_MS } from './flowAdjustedReturns';
import {
  computeProbabilisticSharpe,
  describeReturns,
} from './sharpeStatistics';
import {
  FILLS_LOOKBACK_MS,
  measureStageThree,
  measureStageTwo,
  UnreadableResponseError,
  WalletScorer,
} from './walletScorer';

const WALLET = '0xad5455057feac38a2dd2210d0fac0854d1eb6203';
const START = Date.UTC(2025, 6, 3);
const AS_OF = START + 40 * WEEK_MS;
const MINUTE_MS = 60_000;
const PNL_STEPS = [3_000, -1_000, 2_000, 500, -500, 2_500, 1_500, -2_000];

type Point = [time: number, accountValue: number, pnl: number];

function history(
  start: number,
  stepMs: number,
  steps: number[],
  perpShare = 1,
): { combined: Point[]; perp: Point[] } {
  const combined: Point[] = [[start, 200_000, 0]];
  const perp: Point[] = [[start, 200_000, 0]];
  steps.forEach((step, index) => {
    const [, value, pnl] = combined[index];
    const time = start + (index + 1) * stepMs;
    combined.push([time, value + step, pnl + step]);
    perp.push([time, 0, perp[index][2] + step * perpShare]);
  });
  return { combined, perp };
}

function period(points: Point[], volume: string): PortfolioPeriod {
  return {
    accountValueHistory: points.map(([time, value]) => [time, String(value)]),
    pnlHistory: points.map(([time, , pnl]) => [time, String(pnl)]),
    vlm: volume,
  };
}

function portfolio(perpShare = 1): PortfolioResponse {
  const weeks = history(
    START,
    WEEK_MS,
    Array.from({ length: 40 }, (_, index) => PNL_STEPS[index % 8]),
    perpShare,
  );
  const days = history(
    AS_OF - 30 * DAY_MS,
    DAY_MS,
    Array.from({ length: 30 }, (_, index) => PNL_STEPS[index % 8] / 10),
    perpShare,
  );
  return [
    ['month', period(days.combined, '5000000')],
    ['perpMonth', period(days.perp, '5000000')],
    ['allTime', period(weeks.combined, '40000000')],
    ['perpAllTime', period(weeks.perp, '40000000')],
  ];
}

function leaderboardRow(monthVolume: number): LeaderboardRow {
  const window = { pnl: 1, roi: 0, volume: monthVolume };
  return {
    address: WALLET,
    accountValue: 230_000,
    windows: { day: window, week: window, month: window, allTime: window },
  };
}

function target(overrides: Partial<StageTwoTarget> = {}): StageTwoTarget {
  return {
    address: WALLET,
    row: leaderboardRow(5_000_000),
    isTracked: false,
    ...overrides,
  };
}

function fill(time: number, overrides: Partial<ScoredFill> = {}): ScoredFill {
  return {
    coin: 'HYPE',
    px: '30',
    sz: '100',
    side: 'B',
    time,
    startPosition: '0',
    oid: time,
    crossed: true,
    tid: time,
    ...overrides,
  };
}

function swingFills(asOf: number): ScoredFill[] {
  const fills: ScoredFill[] = [];
  for (let day = 1; day <= 28; day += 2) {
    const openedAt = asOf - FILLS_LOOKBACK_MS + day * DAY_MS;
    fills.push(fill(openedAt));
    fills.push(
      fill(openedAt + 600 * MINUTE_MS, {
        side: 'A',
        startPosition: '100',
        px: '31',
      }),
    );
  }
  return fills;
}

describe('measureStageTwo', () => {
  it('scores a steady perp trader with 40 weeks of history', () => {
    const result = measureStageTwo(target(), portfolio());
    const steps = Array.from(
      { length: 40 },
      (_, index) => PNL_STEPS[index % 8],
    );
    const values = [200_000];
    const weeklyReturns = steps.map((step, index) => {
      values.push(values[index] + step);
      return step / values[index];
    });

    expect(result.historyDays).toBe(280);
    expect(result.periods).toBe(40);
    expect(result.accountValueUsd).toBe(String(values[40]));
    expect(result.psr).toBeCloseTo(
      computeProbabilisticSharpe(describeReturns(weeklyReturns)!)!,
      12,
    );
    expect(result.psr).toBeGreaterThan(0.8);
    expect(result.perpPnlShare).toBe(1);
    expect(result.edgeBps).toBeCloseTo((30_000 / 40_000_000) * 10_000, 12);
    expect(result.positiveShare).toBeCloseTo(
      weeklyReturns.slice(-26).filter((value) => value > 0).length / 26,
      12,
    );
    expect(result.gateFailures).toEqual([]);
    expect(result.components).toMatchObject({
      significance: result.psr,
      drawdown: result.maxDrawdown,
      edge: result.edgeBps,
      recency: result.sortino30d,
      consistency: result.positiveShare,
      copyability: null,
    });
  });

  it('flags a leaderboard row that carries sub-account volume', () => {
    const result = measureStageTwo(
      target({ row: leaderboardRow(6_000_001) }),
      portfolio(),
    );

    expect(result.gateFailures).toEqual(['sub_account_master']);
  });

  it('skips the sub-account check for a tracked wallet off the leaderboard', () => {
    const result = measureStageTwo(
      target({ row: null, isTracked: true }),
      portfolio(),
    );

    expect(result.gateFailures).toEqual([]);
    expect(result.isTracked).toBe(true);
  });

  it('flags a wallet whose profit came mostly from spot', () => {
    const result = measureStageTwo(target(), portfolio(0.2));

    expect(result.perpPnlShare).toBeCloseTo(0.2, 12);
    expect(result.gateFailures).toContain('spot_driven');
  });
});

describe('measureStageThree', () => {
  const stageTwo = measureStageTwo(target(), portfolio());
  const requested = { from: AS_OF - FILLS_LOOKBACK_MS, to: AS_OF };

  it('adds the behaviour metrics, the copyability component and the window', () => {
    const result = measureStageThree(
      stageTwo,
      {
        fills: swingFills(AS_OF),
        firstPageFull: false,
        reachedPageLimit: false,
      },
      requested,
      [],
      AS_OF,
    );

    expect(result.holdMinutes).toBeCloseTo(600, 9);
    expect(result.components.copyability).toBeCloseTo(Math.log(600), 12);
    expect(result.fillsWindowFrom).toBe(requested.from);
    expect(result.gateFailures).toEqual([]);
  });

  it('keeps the stage-two failures and adds a recent liquidation', () => {
    const failing = { ...stageTwo, gateFailures: ['short_history' as const] };

    const result = measureStageThree(
      failing,
      {
        fills: swingFills(AS_OF),
        firstPageFull: false,
        reachedPageLimit: false,
      },
      requested,
      [{ time: AS_OF - DAY_MS, delta: { type: 'liquidation' } }],
      AS_OF,
    );

    expect(result.gateFailures).toEqual([
      'short_history',
      'recent_liquidation',
    ]);
  });
});

describe('WalletScorer', () => {
  function createScorer(maxPages: number) {
    const info = {
      portfolio: vi.fn(),
      userFillsByTime: vi.fn(),
      userNonFundingLedgerUpdates: vi.fn().mockResolvedValue([]),
    };
    const config = {
      getOrThrow: () => maxPages,
    } as unknown as ConfigService<WalletFinderConfig, true>;
    return {
      info,
      scorer: new WalletScorer(
        info as unknown as HyperliquidInfoClient,
        config,
      ),
    };
  }

  function page(
    firstTime: number,
    count: number,
    firstTid: number,
  ): ScoredFill[] {
    return Array.from({ length: count }, (_, index) =>
      fill(firstTime + index * MINUTE_MS, { tid: firstTid + index }),
    );
  }

  const stageTwo = measureStageTwo(target(), portfolio());
  const from = AS_OF - FILLS_LOOKBACK_MS;

  it('reports a portfolio without the windows it needs as unreadable', async () => {
    const { info, scorer } = createScorer(3);
    info.portfolio.mockResolvedValue([]);

    await expect(scorer.scoreStageTwo(target())).rejects.toThrow(
      'The portfolio of wallet 0xad5455057feac38a2dd2210d0fac0854d1eb6203 is unreadable: The portfolio has no allTime window',
    );
  });

  it('validates the portfolio before measuring it', async () => {
    const { info, scorer } = createScorer(3);
    info.portfolio.mockResolvedValue([['allTime', { vlm: 'lots' }]]);

    await expect(scorer.scoreStageTwo(target())).rejects.toThrow(
      UnreadableResponseError,
    );
  });

  it('pages from the last fill time, drops repeated fills and stops on a short page', async () => {
    const { info, scorer } = createScorer(3);
    const first = page(from, 2_000, 1);
    const lastTime = first[1_999].time;
    const second = [
      ...first.slice(-5),
      ...page(lastTime + MINUTE_MS, 1_995, 10_000),
    ];
    info.userFillsByTime
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(page(AS_OF - DAY_MS, 10, 20_000));

    const result = await scorer.scoreStageThree(stageTwo, AS_OF);

    expect(info.userFillsByTime.mock.calls).toEqual([
      [WALLET, from, AS_OF],
      [WALLET, lastTime, AS_OF],
      [WALLET, second[1_999].time, AS_OF],
    ]);
    expect(info.userNonFundingLedgerUpdates).toHaveBeenCalledWith(WALLET, from);
    expect(result.ordersPerDay).toBeCloseTo(
      (2_000 + 1_995 + 10) / ((AS_OF - first[0].time) / DAY_MS),
      9,
    );
    expect(result.fillsWindowFrom).toBe(first[0].time);
  });

  it('ends the window at the last fill read when the page limit is reached', async () => {
    const { info, scorer } = createScorer(2);
    const first = page(from, 2_000, 1);
    const second = page(first[1_999].time + MINUTE_MS, 2_000, 10_000);
    info.userFillsByTime
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const result = await scorer.scoreStageThree(stageTwo, AS_OF);

    expect(info.userFillsByTime).toHaveBeenCalledTimes(2);
    expect(result.ordersPerDay).toBeCloseTo(
      4_000 / ((second[1_999].time - first[0].time) / DAY_MS),
      9,
    );
  });

  it('stops when a full page adds no new fill', async () => {
    const { info, scorer } = createScorer(3);
    const first = page(from, 2_000, 1);
    info.userFillsByTime.mockResolvedValue(first);

    await scorer.scoreStageThree(stageTwo, AS_OF);

    expect(info.userFillsByTime).toHaveBeenCalledTimes(2);
  });
});
