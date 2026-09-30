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
const WALLETS = 32;
const DROPS = 5;
const DROP_INTERVAL_MS = 12_000;
const BEFORE_STORM_MS = 2 * 60_000;
const AFTER_STORM_MS = 2 * 60_000;
const CONNECTION_WINDOW_MS = 60_000;
const NEW_CONNECTIONS_LIMIT = 30;

const settings: LabSettings = {
  scenario: 'upstream-storm',
  collectors: listCollectors(COLLECTORS, 8),
  simulator: { speed: 30, restLagMs: 5_000 },
};

describe('upstream storm', () => {
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await Lab.start(settings);
  });

  afterAll(async () => {
    await lab?.stop();
  });

  it('reconnects under 30 new connections a minute per address and loses nothing when every socket drops', async () => {
    if (!lab) {
      throw new Error('The lab did not start');
    }
    const run = await startRun(lab, await pickTradingWallets(lab, WALLETS));
    await sleep(BEFORE_STORM_MS);
    const stormStartedAt = Date.now();
    let peakNewConnections = 0;
    const sampleConnections = async () => {
      const connections = await (lab as Lab).readConnections();
      for (const address of connections.addresses) {
        peakNewConnections = Math.max(
          peakNewConnections,
          address.newConnectionsLastMinute,
        );
      }
    };
    const sampling = setInterval(() => {
      sampleConnections().catch(() => undefined);
    }, 1_000);
    let droppedSockets = 0;
    let lastDropAt = new Date();
    for (let drop = 1; drop <= DROPS; drop += 1) {
      lastDropAt = new Date();
      droppedSockets += await lab.dropUpstreamSockets();
      if (drop < DROPS) {
        await sleep(DROP_INTERVAL_MS);
      }
    }
    const recovery = await waitUntilRecovered(lab, run.wallets, lastDropAt);
    await sleep(
      Math.max(0, stormStartedAt + CONNECTION_WINDOW_MS + 5_000 - Date.now()),
    );
    clearInterval(sampling);
    await sampleConnections();
    await sleep(AFTER_STORM_MS);
    const { invariants, sections } = await finishRun(lab, run);
    writeReport({
      scenario: settings.scenario,
      title: 'upstream storm',
      purpose:
        'The simulator drops every socket 5 times in a minute, and reconnects must stay under 30 a minute per address with nothing lost.',
      startedAt: lab.startedAt,
      finishedAt: new Date(),
      settings: [
        ['collectors', COLLECTORS],
        ['wallets per collector', 8],
        ['tracked wallets', WALLETS],
        ['socket drops', DROPS],
        ['time between drops, s', DROP_INTERVAL_MS / 1_000],
        ['simulator speed', settings.simulator.speed],
        ['simulator REST lag, ms', settings.simulator.restLagMs],
        ['run before the storm, minutes', BEFORE_STORM_MS / 60_000],
        ['run after the recovery, minutes', AFTER_STORM_MS / 60_000],
      ],
      invariants,
      sections: [
        {
          title: 'Storm',
          lines: [
            `The simulator dropped ${droppedSockets} sockets over ${DROPS} drops (simulated).`,
            `The busiest source address opened ${peakNewConnections} new connections within one minute, against a limit of ${NEW_CONNECTIONS_LIMIT} (simulated).`,
            `Every wallet was subscribed again ${(recovery.subscribeMs / 1_000).toFixed(1)} s and every backfill reported synced ${(recovery.syncMs / 1_000).toFixed(1)} s after the last drop (simulated).`,
          ],
        },
        ...sections,
      ],
    });
    expect(listFailures(invariants)).toEqual([]);
    expect(peakNewConnections).toBeLessThan(NEW_CONNECTIONS_LIMIT);
  });
});
