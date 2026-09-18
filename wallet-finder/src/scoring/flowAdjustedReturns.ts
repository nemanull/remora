import type {
  PortfolioPeriod,
  PortfolioResponse,
  PortfolioWindow,
} from '@remora/sdk';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const MINIMUM_RETURN_BASE_USD = 10_000;

export type JoinedPoint = {
  time: number;
  accountValue: number;
  combinedPnl: number;
  perpPnl: number;
};

export type PeriodReturn = {
  from: number;
  to: number;
  value: number;
};

export type FlowAdjustedHistory = {
  dailyReturns: PeriodReturn[];
  weeklyReturns: PeriodReturn[];
  firstPointAt: number | null;
  lastPointAt: number | null;
};

export function readPortfolioWindow(
  portfolio: PortfolioResponse,
  window: PortfolioWindow,
): PortfolioPeriod {
  const entry = portfolio.find(([name]) => name === window);
  if (!entry) {
    throw new Error(`The portfolio has no ${window} window`);
  }
  return entry[1];
}

function sortByTime<T extends [number, string]>(points: T[]): T[] {
  return [...points].sort((left, right) => left[0] - right[0]);
}

export function joinCombinedAndPerp(
  combined: PortfolioPeriod,
  perp: PortfolioPeriod,
): JoinedPoint[] {
  const combinedPnlByTime = new Map(
    combined.pnlHistory.map(([time, pnl]) => [time, Number(pnl)]),
  );
  const perpPoints = sortByTime(perp.pnlHistory);
  const joined: JoinedPoint[] = [];
  let perpIndex = -1;
  for (const [time, accountValue] of sortByTime(combined.accountValueHistory)) {
    while (
      perpIndex + 1 < perpPoints.length &&
      perpPoints[perpIndex + 1][0] <= time
    ) {
      perpIndex += 1;
    }
    const combinedPnl = combinedPnlByTime.get(time);
    if (perpIndex < 0 || combinedPnl === undefined) {
      continue;
    }
    joined.push({
      time,
      accountValue: Number(accountValue),
      combinedPnl,
      perpPnl: Number(perpPoints[perpIndex][1]),
    });
  }
  return joined;
}

export function keepLastPointPerBucket(
  points: JoinedPoint[],
  bucketMs: number,
): JoinedPoint[] {
  const kept: JoinedPoint[] = [];
  let lastBucket: number | null = null;
  for (const point of points) {
    const bucket = Math.floor(point.time / bucketMs);
    if (bucket === lastBucket) {
      kept[kept.length - 1] = point;
    } else {
      kept.push(point);
      lastBucket = bucket;
    }
  }
  return kept;
}

export function computeFlowAdjustedReturns(
  points: JoinedPoint[],
): PeriodReturn[] {
  const returns: PeriodReturn[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const perpPnlChange = end.perpPnl - start.perpPnl;
    const flow =
      end.accountValue -
      start.accountValue -
      (end.combinedPnl - start.combinedPnl);
    const base = start.accountValue + Math.max(flow, 0);
    if (base < MINIMUM_RETURN_BASE_USD) {
      continue;
    }
    returns.push({
      from: start.time,
      to: end.time,
      value: perpPnlChange / base,
    });
  }
  return returns;
}

export function chainReturns(returns: number[]): number {
  return returns.reduce((growth, value) => growth * (1 + value), 1) - 1;
}

function buildReturns(
  portfolio: PortfolioResponse,
  combinedWindow: PortfolioWindow,
  perpWindow: PortfolioWindow,
  bucketMs: number,
): PeriodReturn[] {
  const joined = joinCombinedAndPerp(
    readPortfolioWindow(portfolio, combinedWindow),
    readPortfolioWindow(portfolio, perpWindow),
  );
  return computeFlowAdjustedReturns(keepLastPointPerBucket(joined, bucketMs));
}

export function buildFlowAdjustedHistory(
  portfolio: PortfolioResponse,
): FlowAdjustedHistory {
  const allTimeValues = sortByTime(
    readPortfolioWindow(portfolio, 'allTime').accountValueHistory,
  );
  return {
    dailyReturns: buildReturns(portfolio, 'month', 'perpMonth', DAY_MS),
    weeklyReturns: buildReturns(portfolio, 'allTime', 'perpAllTime', WEEK_MS),
    firstPointAt: allTimeValues[0]?.[0] ?? null,
    lastPointAt: allTimeValues[allTimeValues.length - 1]?.[0] ?? null,
  };
}
