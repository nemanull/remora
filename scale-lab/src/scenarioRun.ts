import { setTimeout as sleep } from 'node:timers/promises';
import { fetchJson } from './waiting';
import {
  checkNoDuplicateDecisions,
  checkNoMissingFills,
  checkNoUnprovokedRefusals,
  CopyFollowCheck,
  type InvariantResult,
} from './invariants';
import type { Lab } from './labEnvironment';
import {
  countActivity,
  countDecisions,
  LoadSampler,
  measureLatency,
} from './measurements';
import {
  decisionTable,
  latencyTable,
  type ReportSection,
  SAMPLE_COLUMNS,
  sampleRow,
} from './report';

const PROFILE_PATTERN = [
  'scalper',
  'swing',
  'scalper',
  'swing',
  'swing',
  'reckless',
];
const SUBSCRIBE_TIMEOUT_MS = 3 * 60_000;
const SYNC_TIMEOUT_MS = 5 * 60_000;
const FILL_CHECK_MARGIN_MS = 20_000;
const COPY_WATCH_INTERVAL_MS = 60_000;

export type SimWallet = {
  address: string;
  profile: string;
  hasEdge: boolean;
  isVault: boolean;
};

export type LabRun = {
  wallets: string[];
  addedAt: Date;
  syncedAt: Date;
  subscribeMs: number;
  syncMs: number;
  origin: string;
  sampler: LoadSampler;
  copyCheck: CopyFollowCheck;
  stopCopyWatch: () => Promise<void>;
};

export async function readSimWallets(lab: Lab): Promise<SimWallet[]> {
  return fetchJson<SimWallet[]>(`${lab.simulatorUrl}/sim/wallets`);
}

export async function pickTradingWallets(
  lab: Lab,
  count: number,
): Promise<string[]> {
  const wallets = (await readSimWallets(lab)).filter(
    (wallet) => !wallet.isVault,
  );
  const byProfile = new Map<string, string[]>();
  for (const wallet of [...wallets].sort((left, right) =>
    left.address.localeCompare(right.address),
  )) {
    byProfile.set(wallet.profile, [
      ...(byProfile.get(wallet.profile) ?? []),
      wallet.address,
    ]);
  }
  const picked: string[] = [];
  for (let index = 0; picked.length < count; index += 1) {
    const profile = PROFILE_PATTERN[index % PROFILE_PATTERN.length];
    const next = byProfile.get(profile)?.shift();
    if (next !== undefined) {
      picked.push(next);
    }
    if ([...byProfile.values()].every((addresses) => addresses.length === 0)) {
      throw new Error(`The simulator has fewer than ${count} trading wallets`);
    }
  }
  return picked;
}

export async function startRun(lab: Lab, wallets: string[]): Promise<LabRun> {
  const addedAt = new Date();
  await lab.addLeaders(wallets);
  return followRun(lab, wallets, addedAt);
}

export async function followRun(
  lab: Lab,
  wallets: string[],
  addedAt: Date,
  origin = 'when the lab added the first wallet',
): Promise<LabRun> {
  const recovery = await waitUntilRecovered(lab, wallets, addedAt);
  const sampler = new LoadSampler(lab);
  sampler.start();
  const copyCheck = new CopyFollowCheck(lab);
  return {
    wallets,
    addedAt,
    syncedAt: new Date(),
    subscribeMs: recovery.subscribeMs,
    syncMs: recovery.syncMs,
    origin,
    sampler,
    copyCheck,
    stopCopyWatch: watchCopies(copyCheck),
  };
}

function watchCopies(copyCheck: CopyFollowCheck): () => Promise<void> {
  const stop = new AbortController();
  const watching = (async () => {
    for (;;) {
      try {
        await sleep(COPY_WATCH_INTERVAL_MS, undefined, { signal: stop.signal });
      } catch {
        return;
      }
      await copyCheck.inspect().catch(() => undefined);
    }
  })();
  return async () => {
    stop.abort();
    await watching;
  };
}

export async function waitUntilRecovered(
  lab: Lab,
  wallets: string[],
  since: Date,
): Promise<{ subscribeMs: number; syncMs: number }> {
  await lab.waitUntilSubscribed(wallets, SUBSCRIBE_TIMEOUT_MS);
  const subscribeMs = Date.now() - since.getTime();
  await lab.waitUntilSynced(wallets, since, SYNC_TIMEOUT_MS);
  return { subscribeMs, syncMs: Date.now() - since.getTime() };
}

export async function finishRun(
  lab: Lab,
  run: LabRun,
  provokedLimits: readonly string[] = [],
): Promise<{ invariants: InvariantResult[]; sections: ReportSection[] }> {
  const load = run.sampler.stop();
  await run.stopCopyWatch();
  await lab.waitUntilSynced(run.wallets, run.syncedAt, SYNC_TIMEOUT_MS);
  const fillsUntil = Date.now() - FILL_CHECK_MARGIN_MS;
  const invariants = [
    await checkNoMissingFills(lab, run.wallets, fillsUntil),
    await run.copyCheck.finish(),
    await checkNoDuplicateDecisions(lab),
    await checkNoUnprovokedRefusals(lab, provokedLimits),
  ];
  const activity = await countActivity(lab.database, run.addedAt);
  const sections: ReportSection[] = [
    {
      title: 'Activity',
      lines: [
        `Counted from ${run.addedAt.toISOString()}, ${run.origin}.`,
        `Every wallet was subscribed at the simulator ${Math.round(run.subscribeMs / 100) / 10} s (simulated) after that, and every backfill reported synced ${Math.round(run.syncMs / 100) / 10} s (simulated) after it.`,
      ],
      table: {
        columns: ['Count', 'Value (simulated)'],
        rows: Object.entries(activity),
      },
    },
    {
      title: 'Decisions by verdict and reason',
      table: decisionTable(await countDecisions(lab.database, run.addedAt)),
    },
    {
      title: 'Latency of stream signals',
      lines: [
        'Each step is measured from the timestamps stored in Postgres.',
        'Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.',
      ],
      table: latencyTable(await measureLatency(lab.database, run.syncedAt)),
    },
    {
      title: 'Load',
      lines: [
        'Sampled every 5 s between the end of the initial sync and the end of the run.',
        "The server values are prom-client's event-loop lag p99 and the REST weight the server spent over each minute, the collector value is the p99 each heartbeat reports, and the connection value is the busiest source address at the simulator.",
      ],
      table: {
        columns: SAMPLE_COLUMNS,
        rows: [
          sampleRow('server event-loop lag p99, ms', load.serverEventLoopP99Ms),
          sampleRow(
            'server REST weight spent per minute, budget 400',
            load.serverWeightPerMinute,
          ),
          sampleRow(
            'collector event-loop delay p99, ms',
            load.collectorEventLoopP99Ms,
          ),
          sampleRow(
            'new upstream connections in the last minute, per address',
            load.newConnectionsPerMinutePerAddress,
          ),
        ],
      },
    },
  ];
  return { invariants, sections };
}

export function listFailures(invariants: InvariantResult[]): string[] {
  return invariants
    .filter((invariant) => !invariant.passed)
    .map(
      (invariant) => `${invariant.name}: ${invariant.violations.join('; ')}`,
    );
}
