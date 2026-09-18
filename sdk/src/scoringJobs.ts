export const DISCOVERY_QUEUE = 'discovery';
export const SCORING_RESULTS_QUEUE = 'scoring-results';
export const RUN_DISCOVERY_JOB = 'run-discovery';
export const WALLET_SCORED_JOB = 'wallet-scored';
export const RUN_FINISHED_JOB = 'run-finished';

export type RunDiscoveryJob = {
  runId: string;
  startedAt: string;
  trackedAddresses: string[];
};

export type ScoreComponent = {
  name:
    | 'significance'
    | 'drawdown'
    | 'edge'
    | 'recency'
    | 'consistency'
    | 'copyability';
  raw: number | null;
  winsorized: number | null;
  percentile: number | null;
  weight: number;
  contribution: number;
};

export type WalletScorePayload = {
  walletAddress: string;
  stage: 2 | 3;
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
};

export type WalletScoredJob = {
  runId: string;
  startedAt: string;
  modelVersion: number;
  score: WalletScorePayload;
};

export type RunFinishedJob = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  modelVersion: number;
  expectedScores: number;
  leaderboardRows: number;
  stageOneCount: number;
  stageTwoCount: number;
  stageThreeCount: number;
};
