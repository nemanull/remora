import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, listCollectors, type LabSettings } from '../src/labEnvironment';
import { writeReport } from '../src/report';
import {
  finishRun,
  listFailures,
  pickTradingWallets,
  startRun,
  waitUntilRecovered,
} from '../src/scenarioRun';

const COLLECTORS = 4;
const WALLETS = 24;
const OUTAGE_MS = 30_000;
const BEFORE_OUTAGE_MS = 2 * 60_000;
const AFTER_OUTAGE_MS = 2 * 60_000;
const STORAGE_CLOSE = /Session of cluster \d+ closed with code 4005/g;

const settings: LabSettings = {
  scenario: 'database-outage',
  collectors: listCollectors(COLLECTORS, 8),
  simulator: { speed: 30, restLagMs: 5_000 },
};

describe('database outage', () => {
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await Lab.start(settings);
  });

  afterAll(async () => {
    await lab?.stop();
  });

  it('closes sessions with 4005 while Postgres is down for 30 s and recovers every fill', async () => {
    if (!lab) {
      throw new Error('The lab did not start');
    }
    const run = await startRun(lab, await pickTradingWallets(lab, WALLETS));
    await sleep(BEFORE_OUTAGE_MS);
    const stoppedAt = new Date();
    await lab.stopPostgres();
    await sleep(OUTAGE_MS);
    await lab.startPostgres();
    const startedAt = new Date();
    const recovery = await waitUntilRecovered(lab, run.wallets, startedAt);
    await sleep(AFTER_OUTAGE_MS);
    const storageCloses =
      (await lab.readServerLog()).match(STORAGE_CLOSE)?.length ?? 0;
    const { invariants, sections } = await finishRun(lab, run);
    writeReport({
      scenario: settings.scenario,
      title: 'database outage',
      purpose:
        'Postgres is stopped for 30 s under load, and the sessions must close with 4005, reconnect and backfill with nothing lost.',
      startedAt: lab.startedAt,
      finishedAt: new Date(),
      settings: [
        ['collectors', COLLECTORS],
        ['wallets per collector', 8],
        ['tracked wallets', WALLETS],
        ['Postgres outage, s', OUTAGE_MS / 1_000],
        ['simulator speed', settings.simulator.speed],
        ['simulator REST lag, ms', settings.simulator.restLagMs],
        ['run before the outage, minutes', BEFORE_OUTAGE_MS / 60_000],
        ['run after the recovery, minutes', AFTER_OUTAGE_MS / 60_000],
      ],
      invariants,
      sections: [
        {
          title: 'Outage',
          lines: [
            `Postgres was down from ${stoppedAt.toISOString()} to ${startedAt.toISOString()} (simulated).`,
            `The server closed ${storageCloses} collector sessions with 4005 storage_unavailable (simulated).`,
            `Every backfill reported synced ${(recovery.syncMs / 1_000).toFixed(1)} s after Postgres was back (simulated).`,
          ],
        },
        ...sections,
      ],
    });
    expect(listFailures(invariants)).toEqual([]);
    expect(storageCloses).toBeGreaterThan(0);
  });
});
