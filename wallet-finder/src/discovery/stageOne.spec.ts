import { describe, expect, it } from 'vitest';
import { passesStageOne, planStageTwo } from './stageOne';
import type { LeaderboardRow, WindowPerformance } from './statsDataFiles';

type RowShape = {
  accountValue?: number;
  monthVolume?: number;
  monthPnl?: number;
  allTimePnl?: number;
  allTimeVolume?: number;
};

function row(address: string, shape: RowShape = {}): LeaderboardRow {
  const window = (pnl: number, volume: number): WindowPerformance => ({
    pnl,
    roi: 0,
    volume,
  });
  const accountValue = shape.accountValue ?? 1_000_000;
  return {
    address,
    accountValue,
    windows: {
      day: window(0, 0),
      week: window(0, 0),
      month: window(shape.monthPnl ?? 50_000, shape.monthVolume ?? 10_000_000),
      allTime: window(
        shape.allTimePnl ?? 400_000,
        shape.allTimeVolume ?? 80_000_000,
      ),
    },
  };
}

const NO_VAULTS = new Set<string>();

describe('passesStageOne', () => {
  it('keeps a large, active, profitable account with edge', () => {
    expect(passesStageOne(row('0xa'), NO_VAULTS)).toBe(true);
  });

  it.each<[string, RowShape]>([
    ['under 100,000 USD of account value', { accountValue: 99_999 }],
    ['under 1,000,000 USD of month volume', { monthVolume: 999_999 }],
    [
      'a month turnover under 0.5',
      { accountValue: 2_100_000, monthVolume: 1_000_000 },
    ],
    [
      'a month turnover over 100',
      { accountValue: 100_000, monthVolume: 10_000_001 },
    ],
    ['a losing month', { monthPnl: -1 }],
    ['a losing history', { allTimePnl: 0 }],
    [
      'an allTime edge under 25 bps',
      { allTimePnl: 199_999, allTimeVolume: 80_000_000 },
    ],
  ])('drops an account with %s', (_, shape) => {
    expect(passesStageOne(row('0xa', shape), NO_VAULTS)).toBe(false);
  });

  it('keeps the inclusive boundaries', () => {
    expect(
      passesStageOne(
        row('0xa', {
          accountValue: 100_000,
          monthVolume: 1_000_000,
          allTimePnl: 200_000,
          allTimeVolume: 80_000_000,
        }),
        NO_VAULTS,
      ),
    ).toBe(true);
    expect(
      passesStageOne(
        row('0xa', { accountValue: 2_000_000, monthVolume: 1_000_000 }),
        NO_VAULTS,
      ),
    ).toBe(true);
  });

  it('drops vaults and accounts worth nothing', () => {
    expect(passesStageOne(row('0xa'), new Set(['0xa']))).toBe(false);
    expect(passesStageOne(row('0xa', { accountValue: 0 }), NO_VAULTS)).toBe(
      false,
    );
  });
});

describe('planStageTwo', () => {
  const rows = [
    row('0xsmall', { accountValue: 200_000, monthVolume: 2_000_000 }),
    row('0xbig', { accountValue: 5_000_000 }),
    row('0xmid', { accountValue: 1_000_000 }),
    row('0xloser', { monthPnl: -10 }),
  ];

  it('orders the survivors by account value and counts them before the limit', () => {
    const plan = planStageTwo(rows, NO_VAULTS, [], 2);

    expect(plan.survivorCount).toBe(3);
    expect(plan.targets.map((target) => target.address)).toEqual([
      '0xbig',
      '0xmid',
    ]);
  });

  it('lets tracked wallets bypass the filters and the limit', () => {
    const plan = planStageTwo(rows, NO_VAULTS, ['0xloser', '0xgone'], 1);

    expect(plan.targets).toEqual([
      { address: '0xloser', row: rows[3], isTracked: true },
      { address: '0xgone', row: null, isTracked: true },
      { address: '0xbig', row: rows[1], isTracked: false },
    ]);
  });

  it('scores a tracked survivor once', () => {
    const plan = planStageTwo(rows, NO_VAULTS, ['0xbig']);

    expect(plan.targets.map((target) => target.address)).toEqual([
      '0xbig',
      '0xmid',
      '0xsmall',
    ]);
    expect(plan.targets[0].isTracked).toBe(true);
  });
});
