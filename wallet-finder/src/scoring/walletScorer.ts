import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type GateFailure,
  HyperliquidInfoClient,
  type PortfolioResponse,
  type PortfolioWindow,
} from '@remora/sdk';
import { z } from 'zod';
import type { WalletFinderConfig } from '../config';
import type { StageTwoTarget } from '../discovery/stageOne';
import type { ComponentValues } from './compositeScore';
import { computeMaxDrawdown } from './drawdown';
import {
  FILLS_PAGE_SIZE,
  type FillPages,
  type FillWindow,
  measureCoveredWindow,
  measureFillBehaviour,
  type ScoredFill,
} from './fillBehaviour';
import {
  buildFlowAdjustedHistory,
  DAY_MS,
  readPortfolioWindow,
} from './flowAdjustedReturns';
import { evaluateStageThreeGates, evaluateStageTwoGates } from './gates';
import { countRecentLiquidations, type LedgerEntry } from './liquidations';
import {
  computePositiveShare,
  computeProbabilisticSharpe,
  computeSortino,
  describeReturns,
  type ReturnMoments,
} from './sharpeStatistics';

export const SIGNIFICANCE_PERIODS = 52;
export const CONSISTENCY_PERIODS = 26;
export const FILLS_LOOKBACK_MS = 30 * DAY_MS;

export type StageTwoResult = {
  address: string;
  isTracked: boolean;
  accountValueUsd: string;
  historyDays: number;
  periods: number;
  significanceMoments: ReturnMoments | null;
  psr: number | null;
  maxDrawdown: number | null;
  edgeBps: number | null;
  sortino30d: number | null;
  positiveShare: number | null;
  perpPnlShare: number | null;
  gateFailures: GateFailure[];
  components: ComponentValues;
};

export type StageThreeResult = StageTwoResult & {
  holdMinutes: number | null;
  ordersPerDay: number;
  makerShare: number | null;
  coreNotionalShare: number | null;
  fillsWindowFrom: number;
};

export function isStageThreeResult(
  result: StageTwoResult | StageThreeResult,
): result is StageThreeResult {
  return 'fillsWindowFrom' in result;
}

const PORTFOLIO_WINDOWS: readonly PortfolioWindow[] = [
  'day',
  'week',
  'month',
  'allTime',
  'perpDay',
  'perpWeek',
  'perpMonth',
  'perpAllTime',
];
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const decimalString = z.string().regex(DECIMAL_PATTERN);
const timestamp = z.number().int().nonnegative();
const historyPoint = z.tuple([timestamp, decimalString]);

const portfolioSchema = z.array(
  z.tuple([
    z.string(),
    z.object({
      accountValueHistory: z.array(historyPoint),
      pnlHistory: z.array(historyPoint),
      vlm: decimalString,
    }),
  ]),
);

const fillsSchema: z.ZodType<ScoredFill[]> = z.array(
  z.object({
    coin: z.string().min(1),
    px: decimalString,
    sz: decimalString,
    side: z.enum(['A', 'B']),
    time: timestamp,
    startPosition: decimalString,
    oid: z.number().int().nonnegative(),
    crossed: z.boolean(),
    tid: z.number().int().nonnegative(),
  }),
);

const ledgerSchema: z.ZodType<LedgerEntry[]> = z.array(
  z.object({ time: timestamp, delta: z.object({ type: z.string() }) }),
);

export class UnreadableResponseError extends Error {
  constructor(subject: string, address: string, reason: string) {
    super(`The ${subject} of wallet ${address} is unreadable: ${reason}`);
    this.name = 'UnreadableResponseError';
  }
}

function readResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  subject: string,
  address: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new UnreadableResponseError(
      subject,
      address,
      z.prettifyError(parsed.error),
    );
  }
  return parsed.data;
}

function parsePortfolio(value: unknown, address: string): PortfolioResponse {
  const parsed = readResponse(portfolioSchema, value, 'portfolio', address);
  return parsed.filter((entry): entry is PortfolioResponse[number] =>
    (PORTFOLIO_WINDOWS as readonly string[]).includes(entry[0]),
  );
}

function readLastPoint(points: [number, string][]): [number, string] | null {
  let latest: [number, string] | null = null;
  for (const point of points) {
    if (latest === null || point[0] >= latest[0]) {
      latest = point;
    }
  }
  return latest;
}

function readLastPnl(
  portfolio: PortfolioResponse,
  window: PortfolioWindow,
): number {
  const point = readLastPoint(
    readPortfolioWindow(portfolio, window).pnlHistory,
  );
  return point === null ? 0 : Number(point[1]);
}

function divideOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function measureStageTwo(
  target: StageTwoTarget,
  portfolio: PortfolioResponse,
): StageTwoResult {
  const history = buildFlowAdjustedHistory(portfolio);
  const weeklyReturns = history.weeklyReturns.map((period) => period.value);
  const dailyReturns = history.dailyReturns.map((period) => period.value);
  const significanceMoments = describeReturns(
    weeklyReturns.slice(-SIGNIFICANCE_PERIODS),
  );
  const psr =
    significanceMoments === null
      ? null
      : computeProbabilisticSharpe(significanceMoments);
  const maxDrawdown = computeMaxDrawdown(weeklyReturns);
  const positiveShare = computePositiveShare(
    weeklyReturns.slice(-CONSISTENCY_PERIODS),
  );
  const sortino30d = computeSortino(dailyReturns);
  const allTime = readPortfolioWindow(portfolio, 'allTime');
  const month = readPortfolioWindow(portfolio, 'month');
  const allTimePnl = readLastPnl(portfolio, 'allTime');
  const perpPnlShare = divideOrNull(
    readLastPnl(portfolio, 'perpAllTime'),
    allTimePnl,
  );
  const perpPnlShareMonth = divideOrNull(
    readLastPnl(portfolio, 'perpMonth'),
    readLastPnl(portfolio, 'month'),
  );
  const edge = divideOrNull(allTimePnl, Number(allTime.vlm));
  const edgeBps = edge === null ? null : edge * 10_000;
  const historyDays =
    history.firstPointAt === null || history.lastPointAt === null
      ? 0
      : Math.floor((history.lastPointAt - history.firstPointAt) / DAY_MS);
  const gateFailures = evaluateStageTwoGates({
    historyDays,
    periods: weeklyReturns.length,
    perpPnlShareAllTime: perpPnlShare,
    perpPnlShareMonth,
    leaderboardMonthVolume: target.row?.windows.month.volume ?? null,
    portfolioMonthVolume: Number(month.vlm),
    maxDrawdown,
    psr,
  });
  return {
    address: target.address,
    isTracked: target.isTracked,
    accountValueUsd: readLastPoint(allTime.accountValueHistory)?.[1] ?? '0',
    historyDays,
    periods: weeklyReturns.length,
    significanceMoments,
    psr,
    maxDrawdown,
    edgeBps,
    sortino30d,
    positiveShare,
    perpPnlShare,
    gateFailures,
    components: {
      significance: psr,
      drawdown: maxDrawdown,
      edge: edgeBps,
      recency: sortino30d,
      consistency: positiveShare,
      copyability: null,
    },
  };
}

export function measureStageThree(
  stageTwo: StageTwoResult,
  pages: FillPages,
  requested: FillWindow,
  ledger: LedgerEntry[],
  asOf: number,
): StageThreeResult {
  const window = measureCoveredWindow(pages, requested);
  const behaviour = measureFillBehaviour(pages.fills, window);
  const stageThreeFailures = evaluateStageThreeGates({
    recentLiquidations: countRecentLiquidations(ledger, asOf),
    holdMinutes: behaviour.holdMinutes,
    ordersPerDay: behaviour.ordersPerDay,
    copyableOrdersPerWeek: behaviour.copyableOrdersPerWeek,
    coreNotionalShare: behaviour.coreNotionalShare,
  });
  const copyability =
    behaviour.holdMinutes !== null && behaviour.holdMinutes > 0
      ? Math.log(behaviour.holdMinutes)
      : null;
  return {
    ...stageTwo,
    holdMinutes: behaviour.holdMinutes,
    ordersPerDay: behaviour.ordersPerDay,
    makerShare: behaviour.makerShare,
    coreNotionalShare: behaviour.coreNotionalShare,
    fillsWindowFrom: window.from,
    gateFailures: [...stageTwo.gateFailures, ...stageThreeFailures],
    components: { ...stageTwo.components, copyability },
  };
}

@Injectable()
export class WalletScorer {
  private readonly maxPages: number;

  constructor(
    private readonly info: HyperliquidInfoClient,
    config: ConfigService<WalletFinderConfig, true>,
  ) {
    this.maxPages = config.getOrThrow('STAGE_THREE_MAX_PAGES', { infer: true });
  }

  async scoreStageTwo(target: StageTwoTarget): Promise<StageTwoResult> {
    const portfolio = parsePortfolio(
      await this.info.portfolio(target.address),
      target.address,
    );
    try {
      return measureStageTwo(target, portfolio);
    } catch (error) {
      throw new UnreadableResponseError(
        'portfolio',
        target.address,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async scoreStageThree(
    stageTwo: StageTwoResult,
    asOf: number,
  ): Promise<StageThreeResult> {
    const requested = { from: asOf - FILLS_LOOKBACK_MS, to: asOf };
    const pages = await this.readFillPages(stageTwo.address, requested);
    const ledger = readResponse(
      ledgerSchema,
      await this.info.userNonFundingLedgerUpdates(
        stageTwo.address,
        requested.from,
      ),
      'ledger',
      stageTwo.address,
    );
    return measureStageThree(stageTwo, pages, requested, ledger, asOf);
  }

  private async readFillPages(
    address: string,
    window: FillWindow,
  ): Promise<FillPages> {
    const fills: ScoredFill[] = [];
    const seen = new Set<string>();
    let cursor = window.from;
    let firstPageFull = false;
    let reachedPageLimit = false;
    for (let page = 1; page <= this.maxPages; page += 1) {
      const pageFills = readResponse(
        fillsSchema,
        await this.info.userFillsByTime(address, cursor, window.to),
        'fills',
        address,
      );
      const added = pageFills.filter((fill) => {
        const key = `${fill.coin}-${fill.tid}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      fills.push(...added);
      if (page === 1) {
        firstPageFull = pageFills.length >= FILLS_PAGE_SIZE;
      }
      if (pageFills.length < FILLS_PAGE_SIZE || added.length === 0) {
        break;
      }
      reachedPageLimit = page === this.maxPages;
      cursor = pageFills[pageFills.length - 1].time;
    }
    return { fills, firstPageFull, reachedPageLimit };
  }
}
