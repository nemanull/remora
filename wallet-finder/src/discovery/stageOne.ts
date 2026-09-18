import type { LeaderboardRow } from './statsDataFiles';

export const MINIMUM_ACCOUNT_VALUE_USD = 100_000;
export const MINIMUM_MONTH_VOLUME_USD = 1_000_000;
export const MINIMUM_MONTH_TURNOVER = 0.5;
export const MAXIMUM_MONTH_TURNOVER = 100;
export const MINIMUM_ALL_TIME_EDGE = 0.0025;

export type StageTwoTarget = {
  address: string;
  row: LeaderboardRow | null;
  isTracked: boolean;
};

export type StageTwoPlan = {
  survivorCount: number;
  targets: StageTwoTarget[];
};

export function passesStageOne(
  row: LeaderboardRow,
  vaultAddresses: ReadonlySet<string>,
): boolean {
  const { month, allTime } = row.windows;
  const turnover =
    row.accountValue > 0 ? month.volume / row.accountValue : Infinity;
  return (
    !vaultAddresses.has(row.address) &&
    row.accountValue >= MINIMUM_ACCOUNT_VALUE_USD &&
    month.volume >= MINIMUM_MONTH_VOLUME_USD &&
    turnover >= MINIMUM_MONTH_TURNOVER &&
    turnover <= MAXIMUM_MONTH_TURNOVER &&
    month.pnl > 0 &&
    allTime.pnl > 0 &&
    allTime.pnl >= MINIMUM_ALL_TIME_EDGE * allTime.volume
  );
}

export function planStageTwo(
  rows: LeaderboardRow[],
  vaultAddresses: ReadonlySet<string>,
  trackedAddresses: string[],
  stageOneLimit?: number,
): StageTwoPlan {
  const tracked = new Set(trackedAddresses);
  const survivors = rows
    .filter((row) => passesStageOne(row, vaultAddresses))
    .sort(
      (left, right) =>
        right.accountValue - left.accountValue ||
        left.address.localeCompare(right.address),
    );
  const kept = survivors
    .filter((row) => !tracked.has(row.address))
    .slice(0, stageOneLimit ?? survivors.length);
  const rowsByAddress = new Map(rows.map((row) => [row.address, row]));
  const targets: StageTwoTarget[] = [
    ...[...tracked].map((address) => ({
      address,
      row: rowsByAddress.get(address) ?? null,
      isTracked: true,
    })),
    ...kept.map((row) => ({ address: row.address, row, isTracked: false })),
  ];
  return { survivorCount: survivors.length, targets };
}
