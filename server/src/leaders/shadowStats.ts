const WEEK_MS = 7 * 86_400_000;

export const REJECTED_ENTRY_REASONS = ['stale_signal', 'price_drift'];
export const UNCOUNTED_ENTRY_REASONS = [
  'below_min_notional',
  'position_not_copied',
  'already_at_target',
];

export type ClosedCopy = {
  closedAt: Date;
  realizedPnl: number;
  feesUsd: number;
  fundingUsd: number;
};

export type CopyResults = {
  closedCopies: number;
  netPnlUsd: number;
  returnOnAllocation: number;
  maxDrawdown: number;
};

export type EntryReasonCount = {
  reason: string;
  count: number;
};

function measureNetPnl(copy: ClosedCopy): number {
  return copy.realizedPnl - copy.feesUsd + copy.fundingUsd;
}

export function summarizeClosedCopies(
  copies: ClosedCopy[],
  allocationUsd: number,
): CopyResults {
  const ordered = [...copies].sort(
    (left, right) => left.closedAt.getTime() - right.closedAt.getTime(),
  );
  let cumulative = 0;
  let peak = 0;
  let deepest = 0;
  for (const copy of ordered) {
    cumulative += measureNetPnl(copy);
    peak = Math.max(peak, cumulative);
    deepest = Math.min(deepest, cumulative - peak);
  }
  return {
    closedCopies: ordered.length,
    netPnlUsd: cumulative,
    returnOnAllocation: cumulative / allocationUsd,
    maxDrawdown: deepest / allocationUsd,
  };
}

export function measureStreamRejectionShare(
  entries: EntryReasonCount[],
): number | null {
  let counted = 0;
  let rejected = 0;
  for (const { reason, count } of entries) {
    if (UNCOUNTED_ENTRY_REASONS.includes(reason)) {
      continue;
    }
    counted += count;
    if (REJECTED_ENTRY_REASONS.includes(reason)) {
      rejected += count;
    }
  }
  return counted === 0 ? null : rejected / counted;
}

export function countNegativeWeeksInRow(
  copies: ClosedCopy[],
  since: Date,
  now: Date,
): number {
  let negativeWeeks = 0;
  for (
    let weekEnd = now.getTime();
    weekEnd - WEEK_MS >= since.getTime();
    weekEnd -= WEEK_MS
  ) {
    const weekStart = weekEnd - WEEK_MS;
    const weekPnl = copies
      .filter(
        (copy) =>
          copy.closedAt.getTime() > weekStart &&
          copy.closedAt.getTime() <= weekEnd,
      )
      .reduce((sum, copy) => sum + measureNetPnl(copy), 0);
    if (weekPnl >= 0) {
      break;
    }
    negativeWeeks += 1;
  }
  return negativeWeeks;
}
