import type { BackfillState, CollectorStats } from './clusterProtocol.js';
import type { ScoreComponent } from './scoringJobs.js';

export type BookName = 'MAIN' | 'SHADOW';
export type ExecutionMode = 'paper' | 'live';
export type PromotionMode = 'auto' | 'manual';
export type WalletStatus = 'CANDIDATE' | 'SHADOW' | 'LIVE' | 'RETIRED';
export type WalletSource = 'LEADERBOARD' | 'MANUAL';
export type FillSource = 'STREAM' | 'SNAPSHOT' | 'BACKFILL';
export type CopyAction = 'OPEN' | 'INCREASE' | 'REDUCE' | 'CLOSE' | 'FLIP';
export type Verdict = 'COPY' | 'SKIP';
export type OrderPurpose = 'ENTRY' | 'EXIT' | 'STOP' | 'RECONCILE';
export type OrderStatus =
  | 'SUBMITTED'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'UNFILLED'
  | 'REJECTED'
  | 'UNKNOWN';
export type PolicyName =
  | 'instrument'
  | 'leader_mode'
  | 'episode'
  | 'exit_path'
  | 'kill_switch'
  | 'signal_age'
  | 'price_drift'
  | 'coin_lock'
  | 'leader_equity'
  | 'sizing'
  | 'margin';
export type PolicyOutcome = 'allow' | 'clip' | 'reject' | 'skip';
export type DecisionReason =
  | 'copied'
  | 'unsupported_instrument'
  | 'isolated_only_market'
  | 'leader_not_copied'
  | 'leader_paused'
  | 'position_not_copied'
  | 'already_at_target'
  | 'kill_switch_active'
  | 'stale_signal'
  | 'price_drift'
  | 'mid_unavailable'
  | 'coin_owned_by_other_leader'
  | 'leader_equity_stale'
  | 'below_min_notional'
  | 'cap_reached'
  | 'insufficient_margin'
  | 'out_of_order';

export type ApiErrorResponse = {
  statusCode: number;
  reason: string;
  message: string;
  details: string[];
};

export type BookValueKind = 'equity' | 'net_pnl';

export type BookSummaryResponse = {
  book: BookName;
  valueKind: BookValueKind;
  valueUsd: string;
  unrealizedPnl: string;
  realizedPnlToday: string;
  dayPnl: string | null;
  grossExposureUsd: string;
  openPositions: number;
  dayStartEquity: string | null;
};

export type KillSwitchResponse = {
  active: boolean;
  reason: string | null;
};

export type ScoringRunResponse = {
  id: string;
  modelVersion: number;
  startedAt: string;
  finishedAt: string | null;
  expectedScores: number | null;
  storedScores: number;
  leaderboardRows: number | null;
  stageOneCount: number | null;
  stageTwoCount: number | null;
  stageThreeCount: number | null;
};

export type LeaderCountsResponse = Record<WalletStatus, number>;

export type OverviewResponse = {
  mode: ExecutionMode;
  promotionMode: PromotionMode;
  books: BookSummaryResponse[];
  killSwitch: KillSwitchResponse;
  lastScoringRun: ScoringRunResponse | null;
  leaderCounts: LeaderCountsResponse;
};

export type WalletScoreResponse = {
  runId: string;
  stage: number;
  passed: boolean;
  gateFailures: string[];
  preliminary: number | null;
  composite: number | null;
  accountValueUsd: string;
  historyDays: number;
  periods: number;
  psr: number | null;
  dsr: number | null;
  maxDrawdown: number | null;
  edgeBps: number | null;
  sortino30d: number | null;
  positiveShare: number | null;
  perpPnlShare: number | null;
  holdMinutes: number | null;
  ordersPerDay: number | null;
  makerShare: number | null;
  coreNotionalShare: number | null;
  fillsWindowFrom: string | null;
  components: ScoreComponent[] | null;
  createdAt: string;
};

export type CopyResultsResponse = {
  book: BookName;
  closedCopies: number;
  netPnlUsd: number;
  returnOnAllocation: number;
  maxDrawdown: number;
};

export type LeaderResponse = {
  address: string;
  status: WalletStatus;
  source: WalletSource;
  score: number | null;
  scoredAt: string | null;
  isPaused: boolean;
  statusReason: string | null;
  trackedSince: string | null;
  liveSince: string | null;
  retiredAt: string | null;
  clusterId: number | null;
  lastFillAt: string | null;
  openCopies: number;
  copyResults: CopyResultsResponse | null;
  latestScore: WalletScoreResponse | null;
};

export type LeaderFillResponse = {
  id: string;
  coin: string;
  tid: string;
  price: string;
  size: string;
  isBuy: boolean;
  time: string;
  startPosition: string;
  direction: string;
  closedPnl: string;
  fee: string;
  isLiquidation: boolean;
  source: FillSource;
  clusterId: number | null;
  receivedAt: string;
  signalledAt: string | null;
};

export type LeaderPositionResponse = {
  coin: string;
  size: string;
  entryPrice: string;
  positionValue: string;
  unrealizedPnl: string;
  leverageType: 'cross' | 'isolated';
  leverage: number;
  liquidationPrice: string | null;
  marginUsed: string;
};

export type LeaderStateResponse = {
  equityUsd: string | null;
  equityAt: string | null;
  positions: LeaderPositionResponse[];
  positionsAt: string | null;
};

export type DecisionTraceLine = {
  policy: PolicyName;
  outcome: PolicyOutcome;
  reason: DecisionReason | null;
  detail: string;
};

export type OrderResponse = {
  id: string;
  decisionId: string | null;
  positionId: string | null;
  book: BookName;
  cloid: string;
  coin: string;
  isBuy: boolean;
  size: string;
  limitPx: string;
  reduceOnly: boolean;
  purpose: OrderPurpose;
  attempt: number;
  status: OrderStatus;
  filledSize: string;
  avgPx: string | null;
  feeUsd: string;
  slippageBps: number | null;
  exchangeOid: string | null;
  error: string | null;
  submittedAt: string;
  acknowledgedAt: string | null;
};

export type DecisionResponse = {
  id: string;
  book: BookName;
  walletAddress: string;
  coin: string;
  signalKey: string;
  signalSource: string;
  action: CopyAction;
  positionBefore: string;
  positionAfter: string;
  leaderVwap: string;
  leaderTime: string;
  receivedAt: string;
  decidedAt: string;
  verdict: Verdict;
  reason: DecisionReason;
  trace: DecisionTraceLine[];
  targetSize: string | null;
  orderSize: string | null;
  orders: OrderResponse[];
};

export type DecisionsPageResponse = {
  decisions: DecisionResponse[];
  nextCursor: string | null;
};

export type CopyPositionResponse = {
  id: string;
  book: BookName;
  walletAddress: string;
  coin: string;
  size: string;
  entryPx: string | null;
  markPx: string | null;
  unrealizedPnl: string | null;
  ratio: string;
  leaderSizeAtSync: string;
  allocationUsd: string;
  stopPx: string | null;
  isOpen: boolean;
  openedAt: string;
  lastOrderAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  realizedPnl: string;
  feesUsd: string;
  fundingUsd: string;
  leaderOpenTid: string;
};

export type CopyPositionsResponse = {
  open: CopyPositionResponse[];
  closed: CopyPositionResponse[];
};

export type LeaderDetailResponse = {
  leader: LeaderResponse;
  state: LeaderStateResponse | null;
  scores: WalletScoreResponse[];
  copies: CopyPositionResponse[];
  recentFills: LeaderFillResponse[];
  recentDecisions: DecisionResponse[];
};

export type BookEquityPointResponse = {
  takenAt: string;
  valueKind: BookValueKind;
  valueUsd: string;
  unrealizedPnl: string;
  realizedPnlToday: string;
  grossExposureUsd: string;
  openPositions: number;
};

export type ClusterWalletResponse = {
  address: string;
  status: WalletStatus;
  subscribedAt: string | null;
  lastEventAt: string | null;
  backfill: BackfillState | null;
};

export type ClusterResponse = {
  id: number;
  isOnline: boolean;
  sessionId: string | null;
  version: string | null;
  maxWallets: number | null;
  assignVersion: number;
  connectedAt: string | null;
  lastHeartbeatAt: string | null;
  stats: CollectorStats | null;
  wallets: ClusterWalletResponse[];
};

export type ClustersResponse = {
  clusters: ClusterResponse[];
  waitingWallets: string[];
};

export type AddLeaderRequest = {
  address: string;
};

export type KillSwitchRequest = {
  active: boolean;
  reason?: string | null;
};

export type DiscoveryRunResponse = {
  runId: string;
  startedAt: string;
  trackedAddresses: number;
};

export type LiveEvent =
  | {
      type: 'decision';
      book: BookName;
      decisionId: string;
      wallet: string;
      coin: string;
      action: string;
      verdict: Verdict;
      reason: string;
      decidedAt: string;
    }
  | {
      type: 'order';
      book: BookName;
      orderId: string;
      cloid: string;
      coin: string;
      purpose: string;
      status: string;
      error: string | null;
    }
  | {
      type: 'copy';
      book: BookName;
      positionId: string;
      wallet: string;
      coin: string;
      change: 'opened' | 'resized' | 'closed';
      size: string;
      realizedPnl: string;
    }
  | {
      type: 'collector';
      clusterId: number;
      change: 'connected' | 'disconnected' | 'heartbeat' | 'assigned';
      stats: CollectorStats | null;
    }
  | {
      type: 'leader';
      wallet: string;
      status: string;
      isPaused: boolean;
      reason: string | null;
    }
  | {
      type: 'killSwitch';
      book: BookName;
      active: boolean;
      reason: string | null;
    }
  | {
      type: 'alert';
      code: string;
      message: string;
      wallet: string | null;
      clusterId: number | null;
    };
