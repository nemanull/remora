import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, listCollectors, type LabSettings } from '../src/labEnvironment';
import { writeReport } from '../src/report';
import {
  finishRun,
  listFailures,
  pickTradingWallets,
  startRun,
} from '../src/scenarioRun';

const WALLETS = 24;
const RUN_MS = 10 * 60_000;

const settings: LabSettings = {
  scenario: 'baseline',
  collectors: listCollectors(3, 8),
  simulator: { speed: 10, restLagMs: 5_000 },
};

describe('baseline', () => {
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await Lab.start(settings);
  });

  afterAll(async () => {
    await lab?.stop();
  });

  it('holds every invariant with 3 collectors and 24 wallets for 10 minutes', async () => {
    if (!lab) {
      throw new Error('The lab did not start');
    }
    const run = await startRun(lab, await pickTradingWallets(lab, WALLETS));
    await sleep(RUN_MS);
    const { invariants, sections } = await finishRun(lab, run);
    writeReport({
      scenario: settings.scenario,
      title: 'baseline',
      purpose:
        '3 collectors hold 24 wallets for 10 minutes in calm conditions.',
      startedAt: lab.startedAt,
      finishedAt: new Date(),
      settings: [
        ['collectors', 3],
        ['wallets per collector', 8],
        ['tracked wallets', WALLETS],
        ['simulator speed', settings.simulator.speed],
        ['simulator REST lag, ms', settings.simulator.restLagMs],
        ['run after the initial sync, minutes', RUN_MS / 60_000],
      ],
      invariants,
      sections,
    });
    expect(listFailures(invariants)).toEqual([]);
  });
});
