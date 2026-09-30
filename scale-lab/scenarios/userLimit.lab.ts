import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, type LabSettings } from '../src/labEnvironment';
import { writeReport } from '../src/report';
import {
  followRun,
  listFailures,
  finishRun,
  pickTradingWallets,
} from '../src/scenarioRun';
import { fetchJson, waitFor } from '../src/waiting';

const WALLETS = 12;
const USER_LIMIT = 10;
const RUN_MS = 6 * 60_000;

const settings: LabSettings = {
  scenario: 'user-limit',
  collectors: [
    { clusterId: 1, maxWallets: 6 },
    { clusterId: 2, maxWallets: 6, sharesAddressWith: 1 },
    { clusterId: 3, maxWallets: 8, startsLater: true },
  ],
  simulator: { speed: 30, restLagMs: 5_000 },
};

describe('user limit', () => {
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await Lab.start(settings);
  });

  afterAll(async () => {
    await lab?.stop();
  });

  it('lowers the capacity of a collector refused with user_limit and moves the refused wallets', async () => {
    if (!lab) {
      throw new Error('The lab did not start');
    }
    const wallets = await pickTradingWallets(lab, WALLETS);
    const addedAt = new Date();
    await lab.addLeaders(wallets);
    const waiting = await waitFor(
      `the wallets refused with user_limit wait for a collector`,
      async () => {
        const { waitingWallets } = await (lab as Lab).readClusters();
        return waitingWallets.length === WALLETS - USER_LIMIT
          ? waitingWallets
          : null;
      },
      120_000,
    );
    const refusals = await fetchJson<{ counts: Record<string, number> }>(
      `${lab.simulatorUrl}/sim/refusals`,
    );
    const beforeMove = await lab.readClusters();
    await lab.startCollector(3);
    const run = await followRun(lab, wallets, addedAt);
    const { clusters } = await lab.readClusters();
    const movedToThird =
      clusters
        .find((cluster) => cluster.id === 3)
        ?.wallets.filter((wallet) => waiting.includes(wallet.address)).length ??
      0;
    const connections = await lab.readConnections();
    await sleep(RUN_MS);
    const { invariants, sections } = await finishRun(lab, run, ['users']);
    writeReport({
      scenario: settings.scenario,
      title: 'user limit',
      purpose:
        'Two collectors of 6 wallets share one source address, so that address asks for 12 users against the limit of 10, and the core must lower the refused capacity and move the rest.',
      startedAt: lab.startedAt,
      finishedAt: new Date(),
      settings: [
        [
          'collectors',
          '1 and 2 with 6 wallets each on one address, 3 with 8 on its own, started later',
        ],
        ['tracked wallets', WALLETS],
        ['simulator user limit per address', USER_LIMIT],
        ['simulator speed', settings.simulator.speed],
        ['simulator REST lag, ms', settings.simulator.restLagMs],
        ['run after the move, minutes', RUN_MS / 60_000],
      ],
      invariants,
      sections: [
        {
          title: 'Refusal and move',
          lines: [
            `The simulator refused ${refusals.counts.users ?? 0} user subscriptions on the shared address (simulated).`,
            `${waiting.length} wallets waited for a collector after the refusals, and ${movedToThird} of them were on collector 3 once it came up (simulated).`,
          ],
          table: {
            columns: [
              'Collector',
              'wallets after the refusals (simulated)',
              'wallets after the move (simulated)',
            ],
            rows: clusters.map((cluster) => [
              cluster.id,
              beforeMove.clusters.find((entry) => entry.id === cluster.id)
                ?.wallets.length ?? 0,
              cluster.wallets.length,
            ]),
          },
        },
        {
          title: 'Users per source address after the move',
          table: {
            columns: ['Address', 'users (simulated)'],
            rows: connections.addresses
              .filter((address) => address.users > 0)
              .map((address) => [address.ip, address.users]),
          },
        },
        ...sections,
      ],
    });
    expect(listFailures(invariants)).toEqual([]);
    expect(movedToThird).toBe(WALLETS - USER_LIMIT);
    expect(
      connections.addresses.every((address) => address.users <= USER_LIMIT),
    ).toBe(true);
  });
});
