import type { PerpMarginMode } from '@remora/sdk';
import type { Decimal } from 'decimal.js';

export type BookName = 'MAIN' | 'SHADOW';
export type SignalSource = 'stream' | 'snapshot' | 'backfill' | 'catch_up';

export type Signal = {
  key: string;
  wallet: string;
  coin: string;
  source: SignalSource;
  fillIds: bigint[];
  firstTid: bigint;
  episodeOpenTid: bigint | null;
  positionBefore: Decimal;
  positionAfter: Decimal;
  touchedZero: boolean;
  vwap: Decimal;
  lastFillTime: Date;
  receivedAt: Date;
};

export type WalletStatus = 'CANDIDATE' | 'SHADOW' | 'LIVE' | 'RETIRED';
export type CopyAction = 'OPEN' | 'INCREASE' | 'REDUCE' | 'CLOSE' | 'FLIP';
export type Verdict = 'COPY' | 'SKIP';
export type OrderPurpose = 'ENTRY' | 'EXIT' | 'STOP' | 'RECONCILE';

export type CopyView = {
  id: bigint;
  wallet: string;
  coin: string;
  size: Decimal;
  ratio: Decimal;
  leaderSizeAtSync: Decimal;
  allocationUsd: Decimal;
  notionalUsd: Decimal;
  openedAt: Date;
  lastOrderAt: Date | null;
};

export type BookView = {
  book: BookName;
  equityUsd: Decimal;
  dayStartEquity: Decimal | null;
  freeMarginUsd: Decimal;
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  openCopies: CopyView[];
};

export type MarketView = {
  coin: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  marginMode: PerpMarginMode | null;
  isDelisted: boolean;
  mid: Decimal | null;
  midAt: Date | null;
};

export type LeaderView = {
  wallet: string;
  status: WalletStatus;
  isPaused: boolean;
  equityUsd: Decimal | null;
  equityAt: Date | null;
};

export type CopySettings = {
  liveAllocationUsd: Decimal;
  shadowAllocationUsd: Decimal;
  signalMaxAgeMs: number;
  driftLimitMajorBps: number;
  driftLimitOtherBps: number;
  exitSlippageBps: number;
  leaderEquityMaxAgeMs: number;
  positionCapMultiple: number;
  grossExposureMultiple: number;
  maxOpenCopies: number;
  marginBuffer: number;
  dailyLossLimit: number;
  maxExchangeLeverage: number;
};

export type DecisionContext = {
  book: BookView;
  market: MarketView | null;
  leader: LeaderView;
  settings: CopySettings;
  now: Date;
};

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

export type PolicyOutcome = {
  outcome: 'allow' | 'clip' | 'reject' | 'skip';
  reason: DecisionReason | null;
  detail: string;
};

export type TraceLine = {
  policy: PolicyName;
  outcome: PolicyOutcome['outcome'];
  reason: DecisionReason | null;
  detail: string;
};

export type OrderIntent = {
  book: BookName;
  wallet: string;
  coin: string;
  copyId: bigint | null;
  purpose: OrderPurpose;
  isBuy: boolean;
  size: Decimal;
  limitPx: Decimal;
  reduceOnly: boolean;
  isExactClose: boolean;
  referencePx: Decimal;
};

export type NewCopy = {
  book: BookName;
  wallet: string;
  coin: string;
  ratio: Decimal;
  leaderSizeAtSync: Decimal;
  leaderOpenTid: bigint;
  allocationUsd: Decimal;
  waitsForFill: boolean;
};

export type LeaderSizeSync = {
  copyId: bigint;
  leaderSizeAtSync: Decimal;
  waitsForFill: boolean;
};

export type Decision = {
  book: BookName;
  wallet: string;
  coin: string;
  signalKey: string;
  signalSource: SignalSource;
  action: CopyAction;
  verdict: Verdict;
  reason: DecisionReason;
  trace: TraceLine[];
  positionBefore: Decimal;
  positionAfter: Decimal;
  leaderVwap: Decimal;
  leaderTime: Date;
  receivedAt: Date;
  decidedAt: Date;
  targetSize: Decimal | null;
  orderSize: Decimal | null;
  intents: OrderIntent[];
  closesCopyId: bigint | null;
  opensCopy: NewCopy | null;
  leaderSizeSync: LeaderSizeSync | null;
};
