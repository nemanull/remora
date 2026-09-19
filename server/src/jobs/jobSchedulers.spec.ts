import { describe, expect, it } from 'vitest';
import { listJobSchedulers } from './jobSchedulers';

describe('listJobSchedulers', () => {
  it('lists every scheduled job of the jobs table in paper mode', () => {
    const schedulers = listJobSchedulers('0 2 * * *', 'paper');

    expect(schedulers.map(({ queue, job }) => `${queue}/${job}`)).toEqual([
      'selection/start-discovery',
      'maintenance/reconcile-copies',
      'maintenance/snapshot-books',
      'maintenance/accrue-paper-funding',
      'maintenance/refresh-markets',
      'maintenance/roll-trading-day',
      'maintenance/prune-fills',
    ]);
  });

  it('adds the live account reconciliation only in live mode', () => {
    const schedulers = listJobSchedulers('0 2 * * *', 'live');

    expect(schedulers.at(-1)).toEqual({
      queue: 'maintenance',
      job: 'reconcile-live-account',
      repeat: { every: 60_000 },
    });
  });

  it('starts discovery on the configured cron in UTC', () => {
    const [startDiscovery] = listJobSchedulers('30 3 * * *', 'paper');

    expect(startDiscovery.repeat).toEqual({ pattern: '30 3 * * *', tz: 'UTC' });
  });

  it('uses job names that BullMQ accepts as ids', () => {
    for (const { job } of listJobSchedulers('0 2 * * *', 'live')) {
      expect(job).not.toContain(':');
    }
  });
});
