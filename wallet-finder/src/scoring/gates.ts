import type { GateFailure } from '@remora/sdk';

export const MINIMUM_HISTORY_DAYS = 182;
export const MINIMUM_PERIODS = 26;
export const MINIMUM_PERP_PNL_SHARE = 0.5;
export const MAXIMUM_PERP_PNL_SHARE = 1.5;
export const MAXIMUM_LEADERBOARD_VOLUME_RATIO = 1.2;
export const DRAWDOWN_LIMIT = -0.5;
export const MINIMUM_PSR = 0.8;
export const MINIMUM_HOLD_MINUTES = 60;
export const MAXIMUM_ORDERS_PER_DAY = 50;
export const MINIMUM_COPYABLE_ORDERS_PER_WEEK = 2;
export const MINIMUM_CORE_NOTIONAL_SHARE = 0.7;

export type StageTwoGateInput = {
  historyDays: number;
  periods: number;
  perpPnlShareAllTime: number | null;
  perpPnlShareMonth: number | null;
  leaderboardMonthVolume: number | null;
  portfolioMonthVolume: number;
  maxDrawdown: number | null;
  psr: number | null;
};

export type StageThreeGateInput = {
  recentLiquidations: number;
  holdMinutes: number | null;
  ordersPerDay: number;
  copyableOrdersPerWeek: number;
  coreNotionalShare: number | null;
};

function isPerpDriven(share: number | null): boolean {
  return (
    share !== null &&
    share >= MINIMUM_PERP_PNL_SHARE &&
    share <= MAXIMUM_PERP_PNL_SHARE
  );
}

export function evaluateStageTwoGates(input: StageTwoGateInput): GateFailure[] {
  const failures: GateFailure[] = [];
  if (
    input.historyDays < MINIMUM_HISTORY_DAYS ||
    input.periods < MINIMUM_PERIODS
  ) {
    failures.push('short_history');
  }
  if (
    !isPerpDriven(input.perpPnlShareAllTime) ||
    !isPerpDriven(input.perpPnlShareMonth)
  ) {
    failures.push('spot_driven');
  }
  if (
    input.leaderboardMonthVolume !== null &&
    input.leaderboardMonthVolume >
      MAXIMUM_LEADERBOARD_VOLUME_RATIO * input.portfolioMonthVolume
  ) {
    failures.push('sub_account_master');
  }
  if (input.maxDrawdown === null || input.maxDrawdown <= DRAWDOWN_LIMIT) {
    failures.push('deep_drawdown');
  }
  if (input.psr === null || input.psr < MINIMUM_PSR) {
    failures.push('not_significant');
  }
  return failures;
}

export function evaluateStageThreeGates(
  input: StageThreeGateInput,
): GateFailure[] {
  const failures: GateFailure[] = [];
  if (input.recentLiquidations > 0) {
    failures.push('recent_liquidation');
  }
  if (input.holdMinutes !== null && input.holdMinutes < MINIMUM_HOLD_MINUTES) {
    failures.push('short_holds');
  }
  if (input.ordersPerDay > MAXIMUM_ORDERS_PER_DAY) {
    failures.push('hyperactive');
  }
  if (input.copyableOrdersPerWeek < MINIMUM_COPYABLE_ORDERS_PER_WEEK) {
    failures.push('inactive');
  }
  if (
    input.coreNotionalShare !== null &&
    input.coreNotionalShare < MINIMUM_CORE_NOTIONAL_SHARE
  ) {
    failures.push('off_main_dex');
  }
  return failures;
}
