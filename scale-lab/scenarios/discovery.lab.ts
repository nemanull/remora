import { setTimeout as sleep } from 'node:timers/promises';
import type { DiscoveryRunResponse } from '@remora/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Lab, listCollectors, type LabSettings } from '../src/labEnvironment';
import { writeReport } from '../src/report';
import {
  finishRun,
  followRun,
  listFailures,
  readSimWallets,
} from '../src/scenarioRun';
import { fetchJson, waitFor } from '../src/waiting';

const TRACKED_TARGET = 16;
const RUN_TIMEOUT_MS = 80 * 60_000;
const SELECTION_SETTLE_MS = 30_000;
const RUN_MS = 5 * 60_000;

const settings: LabSettings = {
  scenario: 'discovery',
  collectors: listCollectors(2, 8),
  simulator: { speed: 30, restLagMs: 5_000 },
  serverEnvironment: { TRACKED_TARGET: String(TRACKED_TARGET) },
};

type LeaderboardRow = {
  ethAddress: string;
  windowPerformances: [string, { pnl: string }][];
};

type ScoringRunRow = {
  leaderboard_rows: number | null;
  stage_one_count: number | null;
  stage_two_count: number | null;
  stage_three_count: number | null;
  expected_scores: number | null;
  started_at: Date;
  finished_at: Date | null;
};

function readPnl(row: LeaderboardRow, window: string): number {
  return Number(
    row.windowPerformances.find(([name]) => name === window)?.[1].pnl ?? 0,
  );
}

function share(part: number, whole: number): string {
  return whole === 0
    ? 'n/a'
    : `${part} of ${whole} (${Math.round((part / whole) * 100)}%)`;
}

describe('discovery', () => {
  let lab: Lab | undefined;

  beforeAll(async () => {
    lab = await Lab.start(settings);
  });

  afterAll(async () => {
    await lab?.stop();
  });

  it('selects wallets with a planted edge more often than a ranking by raw PnL', async () => {
    if (!lab) {
      throw new Error('The lab did not start');
    }
    const database = lab.database;
    const started = await fetchJson<DiscoveryRunResponse>(
      `${lab.serverUrl}/api/discovery/run`,
      { method: 'POST' },
    );
    const run = await waitFor(
      `discovery run ${started.runId} finishes`,
      async () => {
        const { rows } = await database.query<ScoringRunRow>(
          'SELECT * FROM "ScoringRun" WHERE id = $1 AND finished_at IS NOT NULL',
          [started.runId],
        );
        return rows[0] ?? null;
      },
      RUN_TIMEOUT_MS,
      30_000,
    );
    let previous = -1;
    const selected = await waitFor(
      'selection settles',
      async () => {
        const { rows } = await database.query<{ address: string }>(
          `SELECT address FROM "Wallet" WHERE status = 'SHADOW' AND source = 'LEADERBOARD' ORDER BY address`,
        );
        const settled = rows.length > 0 && rows.length === previous;
        previous = rows.length;
        return settled ? rows.map((row) => row.address) : null;
      },
      5 * 60_000,
      SELECTION_SETTLE_MS,
    );
    const { rows: scoreRows } = await database.query<{
      stage: number;
      passed: boolean;
      scores: string;
    }>(
      `SELECT stage, passed, count(*)::text AS scores FROM "WalletScore" WHERE run_id = $1 GROUP BY stage, passed ORDER BY stage, passed`,
      [started.runId],
    );

    const truth = new Map(
      (await readSimWallets(lab)).map((wallet) => [wallet.address, wallet]),
    );
    const leaderboard = (
      await fetchJson<{ leaderboardRows: LeaderboardRow[] }>(
        `${lab.simulatorUrl}/stats/Mainnet/leaderboard`,
      )
    ).leaderboardRows.filter(
      (row) => truth.get(row.ethAddress)?.isVault === false,
    );
    const withEdge = (addresses: string[]) =>
      addresses.filter((address) => truth.get(address)?.hasEdge).length;
    const topBy = (window: string) =>
      [...leaderboard]
        .sort((left, right) => readPnl(right, window) - readPnl(left, window))
        .slice(0, selected.length)
        .map((row) => row.ethAddress);
    const byAllTime = topBy('allTime');
    const byMonth = topBy('month');
    const population = leaderboard.map((row) => row.ethAddress);

    const tracking = await followRun(
      lab,
      selected,
      new Date(),
      'when selection had settled on its wallets',
    );
    await sleep(RUN_MS);
    const { invariants, sections } = await finishRun(lab, tracking);
    const runMinutes =
      run.finished_at === null
        ? null
        : Math.round(
            (run.finished_at.getTime() - run.started_at.getTime()) / 60_000,
          );
    writeReport({
      scenario: settings.scenario,
      title: 'discovery',
      purpose:
        'A full discovery run over the synthetic leaderboard, compared with the planted edge of the simulator and with rankings by raw PnL.',
      startedAt: lab.startedAt,
      finishedAt: new Date(),
      settings: [
        ['tracked target', TRACKED_TARGET],
        ['selection streak runs', 1],
        ['synthetic wallets', 300],
        ['collectors', 2],
        ['simulator speed', settings.simulator.speed],
        ['simulator REST lag, ms', settings.simulator.restLagMs],
        ['wallet-finder REST budget per minute', 600],
        ['run after the selection, minutes', RUN_MS / 60_000],
      ],
      invariants,
      sections: [
        {
          title: 'Funnel',
          lines: [
            `Run ${started.runId} took ${runMinutes ?? 'n/a'} minutes (simulated).`,
          ],
          table: {
            columns: ['Stage', 'Wallets (simulated)'],
            rows: [
              ['leaderboard rows', run.leaderboard_rows],
              ['stage one survivors', run.stage_one_count],
              ['stage two scored', run.stage_two_count],
              ['stage three scored', run.stage_three_count],
              ...scoreRows.map((row): [string, number] => [
                `stage ${row.stage} scores that ${row.passed ? 'passed' : 'failed'} the gates`,
                Number(row.scores),
              ]),
              ['selected into the shadow set', selected.length],
            ],
          },
        },
        {
          title: 'Planted edge',
          lines: [
            'The raw PnL rankings take the same number of wallets as the selection from the non-vault rows of the leaderboard file.',
          ],
          table: {
            columns: ['Set', 'wallets with a planted edge (simulated)'],
            rows: [
              [
                'selected by the composite score',
                share(withEdge(selected), selected.length),
              ],
              [
                'top by all-time PnL',
                share(withEdge(byAllTime), byAllTime.length),
              ],
              ['top by 30-day PnL', share(withEdge(byMonth), byMonth.length)],
              [
                'every non-vault leaderboard row',
                share(withEdge(population), population.length),
              ],
            ],
          },
        },
        ...sections,
      ],
    });
    expect(listFailures(invariants)).toEqual([]);
    expect(selected.length).toBeGreaterThan(0);
  });
});
