export const LIQUIDATION_LOOKBACK_MS = 30 * 86_400_000;

export type LedgerEntry = {
  time: number;
  delta: { type: string };
};

export function countRecentLiquidations(
  entries: LedgerEntry[],
  asOf: number,
): number {
  const since = asOf - LIQUIDATION_LOOKBACK_MS;
  return entries.filter(
    (entry) => entry.delta.type === 'liquidation' && entry.time >= since,
  ).length;
}
