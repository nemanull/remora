import type {
  BookEquityPointResponse,
  BookSummaryResponse,
  ClusterResponse,
  ClusterWalletResponse,
  CollectorStats,
  CopyPositionResponse,
  CopyResultsResponse,
  DecisionReason,
  DecisionResponse,
  DecisionTraceLine,
  LeaderFillResponse,
  LeaderPositionResponse,
  LeaderResponse,
  LeaderStateResponse,
  LiveEvent,
  OrderResponse,
  ScoreComponent,
  ScoringRunResponse,
  WalletScoreResponse,
} from '@remora/sdk';
import type { Decimal } from 'decimal.js';
import type { BookSummary } from '../books/bookState.service';
import type { CopyEvent } from '../copy/copyEvents';
import type {
  BookSnapshot,
  Cluster,
  CopyDecision,
  CopyPosition,
  LeaderFill,
  LeaderState,
  Order,
  ScoringRun,
  Wallet,
  WalletScore,
} from '../generated/prisma/client';

type DecimalValue = { toFixed(): string };

export type LeaderExtras = {
  lastFillAt: Date | null;
  openCopies: number;
  copyResults: CopyResultsResponse | null;
  latestScore: WalletScore | null;
};

export type ClusterWithWallets = Cluster & {
  wallets: Pick<Wallet, 'address' | 'status'>[];
};

function formatDecimal(value: DecimalValue): string {
  return value.toFixed();
}

function formatOptionalDecimal(value: DecimalValue | null): string | null {
  return value === null ? null : value.toFixed();
}

function formatDate(value: Date): string {
  return value.toISOString();
}

function formatOptionalDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function formatEpoch(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function toBookSummaryResponse(
  summary: BookSummary,
): BookSummaryResponse {
  return {
    book: summary.book,
    valueKind: summary.valueKind,
    valueUsd: summary.valueUsd.toFixed(2),
    unrealizedPnl: summary.unrealizedPnl.toFixed(2),
    realizedPnlToday: summary.realizedPnlToday.toFixed(2),
    dayPnl:
      summary.dayStartEquity === null
        ? null
        : summary.valueUsd.minus(summary.dayStartEquity).toFixed(2),
    grossExposureUsd: summary.grossExposureUsd.toFixed(2),
    openPositions: summary.openPositions,
    dayStartEquity:
      summary.dayStartEquity === null
        ? null
        : summary.dayStartEquity.toFixed(2),
  };
}

export function toScoringRunResponse(
  run: ScoringRun,
  storedScores: number,
): ScoringRunResponse {
  return {
    id: run.id,
    modelVersion: run.modelVersion,
    startedAt: formatDate(run.startedAt),
    finishedAt: formatOptionalDate(run.finishedAt),
    expectedScores: run.expectedScores,
    storedScores,
    leaderboardRows: run.leaderboardRows,
    stageOneCount: run.stageOneCount,
    stageTwoCount: run.stageTwoCount,
    stageThreeCount: run.stageThreeCount,
  };
}

export function toWalletScoreResponse(score: WalletScore): WalletScoreResponse {
  return {
    runId: score.runId,
    stage: score.stage,
    passed: score.passed,
    gateFailures: score.gateFailures,
    preliminary: score.preliminary,
    composite: score.composite,
    accountValueUsd: formatDecimal(score.accountValueUsd),
    historyDays: score.historyDays,
    periods: score.periods,
    psr: score.psr,
    dsr: score.dsr,
    maxDrawdown: score.maxDrawdown,
    edgeBps: score.edgeBps,
    sortino30d: score.sortino30d,
    positiveShare: score.positiveShare,
    perpPnlShare: score.perpPnlShare,
    holdMinutes: score.holdMinutes,
    ordersPerDay: score.ordersPerDay,
    makerShare: score.makerShare,
    coreNotionalShare: score.coreNotionalShare,
    fillsWindowFrom: formatOptionalDate(score.fillsWindowFrom),
    components: score.components as ScoreComponent[] | null,
    createdAt: formatDate(score.createdAt),
  };
}

export function toLeaderResponse(
  wallet: Wallet,
  extras: LeaderExtras,
): LeaderResponse {
  return {
    address: wallet.address,
    status: wallet.status,
    source: wallet.source,
    score: wallet.score,
    scoredAt: formatOptionalDate(wallet.scoredAt),
    isPaused: wallet.isPaused,
    statusReason: wallet.statusReason,
    trackedSince: formatOptionalDate(wallet.trackedSince),
    liveSince: formatOptionalDate(wallet.liveSince),
    retiredAt: formatOptionalDate(wallet.retiredAt),
    clusterId: wallet.clusterId,
    lastFillAt: formatOptionalDate(extras.lastFillAt),
    openCopies: extras.openCopies,
    copyResults: extras.copyResults,
    latestScore:
      extras.latestScore === null
        ? null
        : toWalletScoreResponse(extras.latestScore),
  };
}

export function toLeaderFillResponse(fill: LeaderFill): LeaderFillResponse {
  return {
    id: fill.id.toString(),
    coin: fill.coin,
    tid: fill.tid.toString(),
    price: formatDecimal(fill.px),
    size: formatDecimal(fill.sz),
    isBuy: fill.side === 'B',
    time: formatDate(fill.time),
    startPosition: formatDecimal(fill.startPosition),
    direction: fill.dir,
    closedPnl: formatDecimal(fill.closedPnl),
    fee: formatDecimal(fill.fee),
    isLiquidation: fill.isLiquidation,
    source: fill.source,
    clusterId: fill.clusterId,
    receivedAt: formatDate(fill.receivedAt),
    signalledAt: formatOptionalDate(fill.signalledAt),
  };
}

export function toLeaderStateResponse(state: LeaderState): LeaderStateResponse {
  return {
    equityUsd: formatOptionalDecimal(state.equityUsd),
    equityAt: formatOptionalDate(state.equityAt),
    positions: (state.positions ?? []) as LeaderPositionResponse[],
    positionsAt: formatOptionalDate(state.positionsAt),
  };
}

export function toOrderResponse(order: Order): OrderResponse {
  return {
    id: order.id.toString(),
    decisionId: order.decisionId?.toString() ?? null,
    positionId: order.positionId?.toString() ?? null,
    book: order.book,
    cloid: order.cloid,
    coin: order.coin,
    isBuy: order.isBuy,
    size: formatDecimal(order.size),
    limitPx: formatDecimal(order.limitPx),
    reduceOnly: order.reduceOnly,
    purpose: order.purpose,
    attempt: order.attempt,
    status: order.status,
    filledSize: formatDecimal(order.filledSize),
    avgPx: formatOptionalDecimal(order.avgPx),
    feeUsd: formatDecimal(order.feeUsd),
    slippageBps: order.slippageBps,
    exchangeOid: order.exchangeOid?.toString() ?? null,
    error: order.error,
    submittedAt: formatDate(order.submittedAt),
    acknowledgedAt: formatOptionalDate(order.acknowledgedAt),
  };
}

export function toDecisionResponse(
  decision: CopyDecision & { orders: Order[] },
): DecisionResponse {
  return {
    id: decision.id.toString(),
    book: decision.book,
    walletAddress: decision.walletAddress,
    coin: decision.coin,
    signalKey: decision.signalKey,
    signalSource: decision.signalSource,
    action: decision.action,
    positionBefore: formatDecimal(decision.positionBefore),
    positionAfter: formatDecimal(decision.positionAfter),
    leaderVwap: formatDecimal(decision.leaderVwap),
    leaderTime: formatDate(decision.leaderTime),
    receivedAt: formatDate(decision.receivedAt),
    decidedAt: formatDate(decision.decidedAt),
    verdict: decision.verdict,
    reason: decision.reason as DecisionReason,
    trace: decision.trace as DecisionTraceLine[],
    targetSize: formatOptionalDecimal(decision.targetSize),
    orderSize: formatOptionalDecimal(decision.orderSize),
    orders: decision.orders.map(toOrderResponse),
  };
}

export function toCopyPositionResponse(
  position: CopyPosition,
  mark: Decimal | null,
): CopyPositionResponse {
  const markPrice = position.isOpen ? mark : null;
  return {
    id: position.id.toString(),
    book: position.book,
    walletAddress: position.walletAddress,
    coin: position.coin,
    size: formatDecimal(position.size),
    entryPx: formatOptionalDecimal(position.entryPx),
    markPx: markPrice === null ? null : markPrice.toFixed(),
    unrealizedPnl:
      markPrice === null || position.entryPx === null
        ? null
        : markPrice
            .minus(position.entryPx.toFixed())
            .mul(position.size.toFixed())
            .toFixed(2),
    ratio: formatDecimal(position.ratio),
    leaderSizeAtSync: formatDecimal(position.leaderSizeAtSync),
    allocationUsd: formatDecimal(position.allocationUsd),
    stopPx: formatOptionalDecimal(position.stopPx),
    isOpen: position.isOpen,
    openedAt: formatDate(position.openedAt),
    lastOrderAt: formatOptionalDate(position.lastOrderAt),
    closedAt: formatOptionalDate(position.closedAt),
    closeReason: position.closeReason,
    realizedPnl: formatDecimal(position.realizedPnl),
    feesUsd: formatDecimal(position.feesUsd),
    fundingUsd: formatDecimal(position.fundingUsd),
    leaderOpenTid: position.leaderOpenTid.toString(),
  };
}

export function toBookEquityPointResponse(
  snapshot: BookSnapshot,
): BookEquityPointResponse {
  return {
    takenAt: formatDate(snapshot.takenAt),
    valueKind: snapshot.book === 'MAIN' ? 'equity' : 'net_pnl',
    valueUsd: formatDecimal(snapshot.equityUsd),
    unrealizedPnl: formatDecimal(snapshot.unrealizedPnl),
    realizedPnlToday: formatDecimal(snapshot.realizedPnlToday),
    grossExposureUsd: formatDecimal(snapshot.grossExposureUsd),
    openPositions: snapshot.openPositions,
  };
}

export function toClusterResponse(
  cluster: ClusterWithWallets,
): ClusterResponse {
  const stats = cluster.lastStats as CollectorStats | null;
  const reported = new Map(
    (stats?.wallets ?? []).map((wallet) => [wallet.address, wallet]),
  );
  const wallets = cluster.wallets.map((wallet): ClusterWalletResponse => {
    const entry = reported.get(wallet.address);
    return {
      address: wallet.address,
      status: wallet.status,
      subscribedAt: formatEpoch(entry?.subscribedAt ?? null),
      lastEventAt: formatEpoch(entry?.lastEventAt ?? null),
      backfill: entry?.backfill ?? null,
    };
  });
  return {
    id: cluster.id,
    isOnline: cluster.isOnline,
    sessionId: cluster.sessionId,
    version: cluster.version,
    maxWallets: cluster.maxWallets,
    assignVersion: cluster.assignVersion,
    connectedAt: formatOptionalDate(cluster.connectedAt),
    lastHeartbeatAt: formatOptionalDate(cluster.lastHeartbeatAt),
    stats,
    wallets,
  };
}

export function toLiveEvent(event: CopyEvent): LiveEvent {
  switch (event.type) {
    case 'decision':
      return {
        ...event,
        decisionId: event.decisionId.toString(),
        decidedAt: formatDate(event.decidedAt),
      };
    case 'order':
      return { ...event, orderId: event.orderId.toString() };
    case 'copy':
      return { ...event, positionId: event.positionId.toString() };
    default:
      return event;
  }
}
