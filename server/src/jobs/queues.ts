export {
  DISCOVERY_QUEUE,
  RUN_DISCOVERY_JOB,
  RUN_FINISHED_JOB,
  SCORING_RESULTS_QUEUE,
  WALLET_SCORED_JOB,
} from '@remora/sdk';

export const MAINTENANCE_QUEUE = 'maintenance';
export const SELECTION_QUEUE = 'selection';
export const NOTIFICATIONS_QUEUE = 'notifications';

export const START_DISCOVERY_JOB = 'start-discovery';
export const SELECT_LEADERS_JOB = 'select-leaders';
export const RECONCILE_COPIES_JOB = 'reconcile-copies';
export const RECONCILE_LIVE_ACCOUNT_JOB = 'reconcile-live-account';
export const SNAPSHOT_BOOKS_JOB = 'snapshot-books';
export const ACCRUE_PAPER_FUNDING_JOB = 'accrue-paper-funding';
export const REFRESH_MARKETS_JOB = 'refresh-markets';
export const ROLL_TRADING_DAY_JOB = 'roll-trading-day';
export const PRUNE_FILLS_JOB = 'prune-fills';
export const SEND_TELEGRAM_JOB = 'send-telegram';
