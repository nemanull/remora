import {
  ACCRUE_PAPER_FUNDING_JOB,
  MAINTENANCE_QUEUE,
  PRUNE_FILLS_JOB,
  RECONCILE_COPIES_JOB,
  RECONCILE_LIVE_ACCOUNT_JOB,
  REFRESH_MARKETS_JOB,
  ROLL_TRADING_DAY_JOB,
  SELECTION_QUEUE,
  SNAPSHOT_BOOKS_JOB,
  START_DISCOVERY_JOB,
} from './queues';

export type ScheduledQueue = typeof MAINTENANCE_QUEUE | typeof SELECTION_QUEUE;

export type JobScheduler = {
  queue: ScheduledQueue;
  job: string;
  repeat: { every: number } | { pattern: string; tz: 'UTC' };
};

export function listJobSchedulers(
  discoveryCron: string,
  executionMode: 'paper' | 'live',
): JobScheduler[] {
  const schedulers: JobScheduler[] = [
    {
      queue: SELECTION_QUEUE,
      job: START_DISCOVERY_JOB,
      repeat: { pattern: discoveryCron, tz: 'UTC' },
    },
    {
      queue: MAINTENANCE_QUEUE,
      job: RECONCILE_COPIES_JOB,
      repeat: { every: 60_000 },
    },
    {
      queue: MAINTENANCE_QUEUE,
      job: SNAPSHOT_BOOKS_JOB,
      repeat: { every: 300_000 },
    },
    {
      queue: MAINTENANCE_QUEUE,
      job: ACCRUE_PAPER_FUNDING_JOB,
      repeat: { pattern: '1 * * * *', tz: 'UTC' },
    },
    {
      queue: MAINTENANCE_QUEUE,
      job: REFRESH_MARKETS_JOB,
      repeat: { every: 600_000 },
    },
    {
      queue: MAINTENANCE_QUEUE,
      job: ROLL_TRADING_DAY_JOB,
      repeat: { pattern: '0 0 * * *', tz: 'UTC' },
    },
    {
      queue: MAINTENANCE_QUEUE,
      job: PRUNE_FILLS_JOB,
      repeat: { pattern: '0 4 * * *', tz: 'UTC' },
    },
  ];
  if (executionMode === 'live') {
    schedulers.push({
      queue: MAINTENANCE_QUEUE,
      job: RECONCILE_LIVE_ACCOUNT_JOB,
      repeat: { every: 60_000 },
    });
  }
  return schedulers;
}
