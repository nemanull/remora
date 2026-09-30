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
const BETWEEN_RESTARTS_MS = 2 * 60_000;

const settings: LabSettings = {
  scenario: 'core-restart',
  collectors: listCollectors(COLLECTORS, 8),
  simulator: { speed: 30, restLagMs: 10_000 },
};

type Restart = {
  kind: string;
  downMs: number;
  syncMs: number;
};

describe('core restart', () => {
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await Lab.start(settings);
  });

  afterAll(async () => {
    await lab?.stop();
  });

  it('recovers watermarks and catch-ups after a graceful restart and a crash, without duplicate decisions', async () => {
    if (!lab) {
      throw new Error('The lab did not start');
    }
    const run = await startRun(lab, await pickTradingWallets(lab, WALLETS));
    const restarts: Restart[] = [];
    const restartWith = async (kind: string, restart: () => Promise<void>) => {
      await sleep(BETWEEN_RESTARTS_MS);
      const failedAt = new Date();
      await restart();
      const downMs = Date.now() - failedAt.getTime();
      const recovery = await waitUntilRecovered(
        lab as Lab,
        run.wallets,
        failedAt,
      );
      restarts.push({ kind, downMs, syncMs: recovery.syncMs });
    };
    await restartWith('graceful restart with SIGTERM', () =>
      (lab as Lab).restartServer(),
    );
    await restartWith('crash with SIGKILL and a fresh start', () =>
      (lab as Lab).killAndStartServer(),
    );
    await sleep(BETWEEN_RESTARTS_MS);
    const { invariants, sections } = await finishRun(lab, run);
    writeReport({
      scenario: settings.scenario,
      title: 'core restart',
      purpose:
        'The server is restarted gracefully and then killed under load, and watermarks and catch-ups must recover every fill without a duplicate decision.',
      startedAt: lab.startedAt,
      finishedAt: new Date(),
      settings: [
        ['collectors', COLLECTORS],
        ['wallets per collector', 8],
        ['tracked wallets', WALLETS],
        ['simulator speed', settings.simulator.speed],
        ['simulator REST lag, ms', settings.simulator.restLagMs],
        [
          'run before, between and after the restarts, minutes',
          BETWEEN_RESTARTS_MS / 60_000,
        ],
      ],
      invariants,
      sections: [
        {
          title: 'Restarts',
          lines: [
            'Down is the time from the stop until the server answered /health again.',
            'Synced is the time from the stop until every backfill reported synced in a heartbeat of the new session.',
          ],
          table: {
            columns: [
              'Restart',
              'down, s (simulated)',
              'synced, s (simulated)',
            ],
            rows: restarts.map((restart) => [
              restart.kind,
              (restart.downMs / 1_000).toFixed(1),
              (restart.syncMs / 1_000).toFixed(1),
            ]),
          },
        },
        ...sections,
      ],
    });
    expect(listFailures(invariants)).toEqual([]);
  });
});
