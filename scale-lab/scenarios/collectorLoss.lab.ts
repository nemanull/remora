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

const COLLECTORS = 6;
const WALLETS = 24;
const KILLED_COLLECTORS = [2, 5];
const BEFORE_LOSS_MS = 2 * 60_000;
const AFTER_LOSS_MS = 3 * 60_000;
const ASSIGNMENT_GRACE_MS = 30_000;
const RESUBSCRIBE_LIMIT_MS = 90_000;

const settings: LabSettings = {
  scenario: 'collector-loss',
  collectors: listCollectors(COLLECTORS, 8),
  simulator: { speed: 30, restLagMs: 10_000 },
};

describe('collector loss', () => {
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await Lab.start(settings);
  });

  afterAll(async () => {
    await lab?.stop();
  });

  it('moves every wallet of 2 killed collectors after the grace period and loses nothing', async () => {
    if (!lab) {
      throw new Error('The lab did not start');
    }
    const run = await startRun(lab, await pickTradingWallets(lab, WALLETS));
    await sleep(BEFORE_LOSS_MS);
    const { clusters } = await lab.readClusters();
    const orphaned = clusters
      .filter((cluster) => KILLED_COLLECTORS.includes(cluster.id))
      .flatMap((cluster) => cluster.wallets.map((wallet) => wallet.address));
    const killedAt = new Date();
    const running = lab;
    await Promise.all(
      KILLED_COLLECTORS.map((clusterId) => running.killCollector(clusterId)),
    );
    const recovery = await waitUntilRecovered(lab, run.wallets, killedAt);
    await sleep(AFTER_LOSS_MS);
    const { invariants, sections } = await finishRun(lab, run);
    writeReport({
      scenario: settings.scenario,
      title: 'collector loss',
      purpose:
        '2 of 6 collectors are killed mid-run, and their wallets must move to the others after the 30 s grace period with nothing lost.',
      startedAt: lab.startedAt,
      finishedAt: new Date(),
      settings: [
        ['collectors', COLLECTORS],
        ['wallets per collector', 8],
        ['tracked wallets', WALLETS],
        ['killed collectors', KILLED_COLLECTORS.join(' and ')],
        ['assignment grace, ms', ASSIGNMENT_GRACE_MS],
        ['simulator speed', settings.simulator.speed],
        ['simulator REST lag, ms', settings.simulator.restLagMs],
        ['run before the loss, minutes', BEFORE_LOSS_MS / 60_000],
        ['run after the recovery, minutes', AFTER_LOSS_MS / 60_000],
      ],
      invariants,
      sections: [
        {
          title: 'Recovery',
          lines: [
            `The killed collectors held ${orphaned.length} wallets (simulated).`,
            `Every wallet was subscribed at the simulator again ${(recovery.subscribeMs / 1_000).toFixed(1)} s (simulated) after the kill.`,
            `Every backfill reported synced ${(recovery.syncMs / 1_000).toFixed(1)} s (simulated) after the kill.`,
          ],
        },
        ...sections,
      ],
    });
    expect(listFailures(invariants)).toEqual([]);
    expect(orphaned.length).toBeGreaterThan(0);
    expect(recovery.subscribeMs).toBeGreaterThanOrEqual(ASSIGNMENT_GRACE_MS);
    expect(recovery.subscribeMs).toBeLessThan(RESUBSCRIBE_LIMIT_MS);
  });
});
