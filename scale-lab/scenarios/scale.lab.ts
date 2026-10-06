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

const COLLECTORS = 12;
const WALLETS = 96;
const RUN_MS = 10 * 60_000;

const settings: LabSettings = {
  scenario: 'scale',
  collectors: listCollectors(COLLECTORS, 8),
  simulator: { speed: 100, restLagMs: 5_000 },
};

describe('scale', () => {
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await Lab.start(settings);
  });

  afterAll(async () => {
    await lab?.stop();
  });

  it('holds every invariant with 12 collectors and 96 wallets trading 10 times faster', async () => {
    if (!lab) {
      throw new Error('The lab did not start');
    }
    const run = await startRun(lab, await pickTradingWallets(lab, WALLETS));
    await sleep(RUN_MS);
    const { invariants, sections } = await finishRun(lab, run);
    writeReport({
      scenario: settings.scenario,
      title: 'scale',
      purpose:
        '12 collectors hold 96 wallets that trade 10 times faster than in the baseline, to load ingestion, decisions and the server event loop.',
      startedAt: lab.startedAt,
      finishedAt: new Date(),
      settings: [
        ['collectors', COLLECTORS],
        ['wallets per collector', 8],
        ['tracked wallets', WALLETS],
        ['simulator speed', settings.simulator.speed],
        ['simulator REST lag, ms', settings.simulator.restLagMs],
        ['run after the initial sync, minutes', RUN_MS / 60_000],
        ['server REST budget per minute', 400],
        ['of which paper book reads', 120],
        ['paper order latency, ms', 900],
      ],
      invariants,
      sections,
    });
    expect(listFailures(invariants)).toEqual([]);
  });
});
