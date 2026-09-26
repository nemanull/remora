import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type {
  CollectorMessage,
  EventMessage,
  HyperliquidFill,
} from '@remora/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeCore, waitUntil } from './fakeCore';
import { SimulatorProcess, findFreePort } from './simulatorProcess';

const TOKEN = 'integration-token-0123456789abcdef012345';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type SimWallet = { address: string; profile: string };
type HealthBody = {
  status: string;
  wallets: { address: string; isSubscribed: boolean }[];
};

function eventFills(event: EventMessage): HyperliquidFill[] {
  if (event.channel !== 'userFills') {
    return [];
  }
  return Array.isArray(event.payload) ? event.payload : event.payload.fills;
}

describe('collector against the Hyperliquid simulator', () => {
  let simulator: SimulatorProcess;
  let core: FakeCore;
  let app: INestApplication;
  let healthUrl: string;
  let scalper: string;
  let swing: string;
  let fillsSince: Map<string, number>;

  const isEvent =
    (wallet: string, source: string) =>
    (frame: CollectorMessage): boolean =>
      frame.type === 'event' &&
      frame.wallet === wallet &&
      frame.source === source;

  function indexAfter(
    from: number,
    predicate: (frame: CollectorMessage) => boolean,
  ): number {
    const index = core.frames.slice(from + 1).findIndex(predicate);
    return index < 0 ? -1 : from + 1 + index;
  }

  function lastIndexOf(
    predicate: (frame: CollectorMessage) => boolean,
  ): number {
    for (let index = core.frames.length - 1; index >= 0; index -= 1) {
      if (predicate(core.frames[index])) {
        return index;
      }
    }
    return -1;
  }

  async function readHealth(): Promise<{ status: number; body: HealthBody }> {
    const response = await fetch(healthUrl);
    return {
      status: response.status,
      body: (await response.json()) as HealthBody,
    };
  }

  beforeAll(async () => {
    simulator = await SimulatorProcess.start({
      SIM_SEED: '4',
      SIM_WALLETS: '40',
      SIM_SPEED: '50',
      SIM_REST_LAG_MS: '3000',
    });
    const wallets = await simulator.readJson<SimWallet[]>('/sim/wallets');
    scalper =
      wallets.find((wallet) => wallet.profile === 'scalper')?.address ?? '';
    swing = wallets.find((wallet) => wallet.profile === 'swing')?.address ?? '';
    const now = Date.now();
    fillsSince = new Map([
      [scalper, now - 2 * HOUR_MS],
      [swing, now - 2 * DAY_MS],
    ]);
    core = await FakeCore.start({
      token: TOKEN,
      assignOnHello: [...fillsSince].map(([address, since]) => ({
        address,
        fillsSince: since,
      })),
    });
    const port = await findFreePort();
    healthUrl = `http://127.0.0.1:${port}/health`;
    Object.assign(process.env, {
      CLUSTER_ID: '1',
      CLUSTER_TOKEN: TOKEN,
      CORE_URL: core.url,
      HYPERLIQUID_WS_URL: simulator.wsUrl,
      HYPERLIQUID_API_URL: simulator.httpUrl,
      PORT: String(port),
    });
    const { AppModule } = await import('../src/app.module.js');
    app = await NestFactory.create(AppModule, { logger: ['error'] });
    app.enableShutdownHooks();
    await app.listen(port, '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await core?.close();
    await simulator?.stop();
  });

  it('subscribes, forwards live frames, backfills and syncs every assigned wallet', async () => {
    await core.waitForFrame((frame) => frame.type === 'assigned');
    expect(core.framesOf('assigned')[0]).toMatchObject({
      version: 1,
      subscribed: [scalper, swing],
      failed: [],
    });
    const syncedScalper = await core.waitForFrame(
      (frame) => frame.type === 'synced' && frame.wallet === scalper,
    );
    const syncedSwing = await core.waitForFrame(
      (frame) => frame.type === 'synced' && frame.wallet === swing,
    );
    for (const [wallet, syncedIndex] of [
      [scalper, syncedScalper],
      [swing, syncedSwing],
    ] as const) {
      expect(lastIndexOf(isEvent(wallet, 'backfill'))).toBeLessThan(
        syncedIndex,
      );
      expect(
        core.frames.findIndex(isEvent(wallet, 'snapshot')),
      ).toBeGreaterThan(-1);
    }
    await waitUntil(
      () => core.frames.some(isEvent(scalper, 'stream')),
      30_000,
      'a live fill',
    );
    const health = await readHealth();
    expect(health.status).toBe(200);
    expect(health.body.wallets.every((wallet) => wallet.isSubscribed)).toBe(
      true,
    );
  });

  it('sends syncStarted before the new snapshots after an upstream drop and syncs again after the backfill', async () => {
    const before = core.frames.length;
    await simulator.postJson('/sim/faults', { type: 'drop_sockets' });
    const syncStarted = await core.waitForFrame(
      (frame) =>
        frame.type === 'syncStarted' && core.frames.indexOf(frame) >= before,
      20_000,
    );
    expect(core.frames[syncStarted]).toEqual({
      type: 'syncStarted',
      wallets: [scalper, swing],
    });
    for (const wallet of [scalper, swing]) {
      await waitUntil(
        () =>
          indexAfter(
            syncStarted,
            (frame) => frame.type === 'synced' && frame.wallet === wallet,
          ) > 0,
        20_000,
        `wallet ${wallet} to sync again`,
      );
      const snapshot = indexAfter(syncStarted, isEvent(wallet, 'snapshot'));
      const synced = indexAfter(
        syncStarted,
        (frame) => frame.type === 'synced' && frame.wallet === wallet,
      );
      const lastBackfill = lastIndexOf(isEvent(wallet, 'backfill'));
      expect(snapshot).toBeGreaterThan(syncStarted);
      expect(lastBackfill).toBeLessThan(synced);
    }
    const deadline = Date.now() + 10_000;
    let health = await readHealth();
    while (health.status !== 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      health = await readHealth();
    }
    expect(health.status).toBe(200);
  });

  it('backfills fills held back before the first assign of a session although REST lags the stream', async () => {
    const assignment = core.assignOnHello ?? [];
    core.assignOnHello = null;
    const hellos = core.framesOf('hello').length;
    core.dropSession();
    await waitUntil(
      () => core.framesOf('hello').length === hellos + 1,
      20_000,
      'the collector to open a new session',
    );
    const heldFrom = Date.now();
    let held: HyperliquidFill[] = [];
    const deadline = Date.now() + 30_000;
    while (held.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      held = (
        await simulator.readJson<{ fills: HyperliquidFill[] }>(
          `/sim/fills?wallet=${scalper}&since=${heldFrom}`,
        )
      ).fills;
    }
    expect(held.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = core.frames.length - 1;
    core.sendAssign(assignment);
    for (const wallet of [scalper, swing]) {
      await waitUntil(
        () =>
          indexAfter(
            before,
            (frame) => frame.type === 'synced' && frame.wallet === wallet,
          ) > 0,
        30_000,
        `wallet ${wallet} to sync in the new session`,
      );
    }
    const synced = indexAfter(
      before,
      (frame) => frame.type === 'synced' && frame.wallet === scalper,
    );
    const backfilled = core.frames
      .slice(before + 1, synced)
      .filter((frame): frame is EventMessage =>
        isEvent(scalper, 'backfill')(frame),
      )
      .flatMap((event) => eventFills(event).map((fill) => fill.tid));
    for (const fill of held) {
      expect(backfilled).toContain(fill.tid);
    }
  }, 90_000);

  it('forwards every fill the simulator produced for the assigned wallets', async () => {
    const until = Date.now() - 2_000;
    const forwarded = new Set(
      core
        .framesOf('event')
        .flatMap((event) =>
          eventFills(event).map((fill) => `${event.wallet}:${fill.tid}`),
        ),
    );
    let truthCount = 0;
    for (const [wallet, since] of fillsSince) {
      const truth = await simulator.readJson<{ fills: HyperliquidFill[] }>(
        `/sim/fills?wallet=${wallet}&since=${since}&until=${until}`,
      );
      truthCount += truth.fills.length;
      const missing = truth.fills.filter(
        (fill) => !forwarded.has(`${wallet}:${fill.tid}`),
      );
      expect(missing).toEqual([]);
    }
    expect(truthCount).toBeGreaterThan(0);
  });
});
