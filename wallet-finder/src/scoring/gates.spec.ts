import { describe, expect, it } from 'vitest';
import {
  evaluateStageThreeGates,
  evaluateStageTwoGates,
  type StageThreeGateInput,
  type StageTwoGateInput,
} from './gates';

function stageTwo(
  overrides: Partial<StageTwoGateInput> = {},
): StageTwoGateInput {
  return {
    historyDays: 260,
    periods: 37,
    perpPnlShareAllTime: 0.9,
    perpPnlShareMonth: 1.1,
    leaderboardMonthVolume: 45_000_000,
    portfolioMonthVolume: 45_000_000,
    maxDrawdown: -0.38,
    psr: 0.81,
    ...overrides,
  };
}

function stageThree(
  overrides: Partial<StageThreeGateInput> = {},
): StageThreeGateInput {
  return {
    recentLiquidations: 0,
    holdMinutes: 1_289,
    ordersPerDay: 7.2,
    copyableOrdersPerWeek: 50,
    coreNotionalShare: 1,
    ...overrides,
  };
}

describe('evaluateStageTwoGates', () => {
  it('passes a long, perp-driven, significant history', () => {
    expect(evaluateStageTwoGates(stageTwo())).toEqual([]);
  });

  it.each<[string, Partial<StageTwoGateInput>, string]>([
    ['under 182 days of history', { historyDays: 181 }, 'short_history'],
    ['under 26 periods', { periods: 25 }, 'short_history'],
    [
      'spot profits in the allTime window',
      { perpPnlShareAllTime: -0.004 },
      'spot_driven',
    ],
    ['spot profits in the month', { perpPnlShareMonth: 1.51 }, 'spot_driven'],
    [
      'a PnL share that cannot be measured',
      { perpPnlShareMonth: null },
      'spot_driven',
    ],
    [
      'leaderboard volume from sub-accounts',
      { leaderboardMonthVolume: 54_000_001 },
      'sub_account_master',
    ],
    ['a drawdown of exactly -50%', { maxDrawdown: -0.5 }, 'deep_drawdown'],
    ['no drawdown to measure', { maxDrawdown: null }, 'deep_drawdown'],
    ['a PSR under 0.80', { psr: 0.799 }, 'not_significant'],
    ['no PSR to measure', { psr: null }, 'not_significant'],
  ])('fails %s', (_, overrides, reason) => {
    expect(evaluateStageTwoGates(stageTwo(overrides))).toEqual([reason]);
  });

  it('keeps the at-least and at-most thresholds inclusive', () => {
    expect(
      evaluateStageTwoGates(
        stageTwo({
          historyDays: 182,
          periods: 26,
          perpPnlShareAllTime: 0.5,
          perpPnlShareMonth: 1.5,
          leaderboardMonthVolume: 54_000_000,
          psr: 0.8,
        }),
      ),
    ).toEqual([]);
  });

  it('skips the sub-account check for a wallet that is not on the leaderboard', () => {
    expect(
      evaluateStageTwoGates(
        stageTwo({ leaderboardMonthVolume: null, portfolioMonthVolume: 0 }),
      ),
    ).toEqual([]);
  });

  it('lists every failed gate', () => {
    expect(
      evaluateStageTwoGates(
        stageTwo({ periods: 7, perpPnlShareAllTime: 0.05, psr: 0.08 }),
      ),
    ).toEqual(['short_history', 'spot_driven', 'not_significant']);
  });
});

describe('evaluateStageThreeGates', () => {
  it('passes a copyable swing trader', () => {
    expect(evaluateStageThreeGates(stageThree())).toEqual([]);
  });

  it.each<[string, Partial<StageThreeGateInput>, string]>([
    [
      'a liquidation in the last 30 days',
      { recentLiquidations: 1 },
      'recent_liquidation',
    ],
    ['holds under an hour', { holdMinutes: 59.9 }, 'short_holds'],
    ['more than 50 orders a day', { ordersPerDay: 104 }, 'hyperactive'],
    [
      'fewer than 2 copyable orders a week',
      { copyableOrdersPerWeek: 1.9 },
      'inactive',
    ],
    [
      'most notional on builder perps',
      { coreNotionalShare: 0.12 },
      'off_main_dex',
    ],
  ])('fails %s', (_, overrides, reason) => {
    expect(evaluateStageThreeGates(stageThree(overrides))).toEqual([reason]);
  });

  it('does not call a wallet without opens or perp fills a scalper or off-dex, only inactive', () => {
    expect(
      evaluateStageThreeGates(
        stageThree({
          holdMinutes: null,
          ordersPerDay: 0,
          copyableOrdersPerWeek: 0,
          coreNotionalShare: null,
        }),
      ),
    ).toEqual(['inactive']);
  });
});
