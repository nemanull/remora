import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CollectorMessage,
  HyperliquidFill,
  HyperliquidSocketOptions,
  HyperliquidSubscription,
  SubscriptionResult,
} from '@remora/sdk';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { FakeCore, waitUntil } from '../test/fakeCore';
import { validateCollectorConfig, type CollectorConfig } from './config';
import { WatchlistService } from './watchlist.service';

const { ScriptedSocket } = vi.hoisted(() => {
  type Pending = {
    subscription: HyperliquidSubscription;
    resolve: (result: SubscriptionResult) => void;
  };

  class ScriptedSocket {
    static latest: ScriptedSocket | null = null;
    readonly acknowledged = new Map<string, HyperliquidSubscription>();
    readonly requests: {
      method: 'subscribe' | 'unsubscribe';
      subscription: HyperliquidSubscription;
    }[] = [];
    readonly refusals = new Map<string, string>();
    readonly pending: Pending[] = [];
    holdsAcknowledgements = false;
    state: 'connecting' | 'open' | 'closed' = 'open';

    constructor(readonly options: HyperliquidSocketOptions) {
      ScriptedSocket.latest = this;
    }

    start(): void {}

    stop(): Promise<void> {
      return Promise.resolve();
    }

    subscribe(
      subscription: HyperliquidSubscription,
    ): Promise<SubscriptionResult> {
      this.requests.push({ method: 'subscribe', subscription });
      return new Promise((resolve) => {
        const pending = { subscription, resolve };
        if (this.holdsAcknowledgements) {
          this.pending.push(pending);
        } else {
          this.answer(pending, false);
        }
      });
    }

    unsubscribe(subscription: HyperliquidSubscription): Promise<void> {
      this.requests.push({ method: 'unsubscribe', subscription });
      this.acknowledged.delete(JSON.stringify(subscription));
      return Promise.resolve();
    }

    readStats() {
      return {
        state: this.state,
        connectedAt: null,
        reconnects: 0,
        pingRoundTripMs: null,
      };
    }

    acknowledgePending(): void {
      for (const pending of this.pending.splice(0)) {
        this.answer(pending, false);
      }
    }

    emit(channel: string, data: unknown): void {
      this.options.onFrame({ channel, data });
    }

    disconnect(): void {
      this.state = 'closed';
      this.options.onDisconnect?.('closed (code 1006)', 2_000);
    }

    reopen(): void {
      this.state = 'open';
      this.options.onReopen?.();
      for (const subscription of [...this.acknowledged.values()]) {
        this.pending.push({ subscription, resolve: () => undefined });
      }
    }

    acknowledgeResubscriptions(): void {
      for (const pending of this.pending.splice(0)) {
        this.answer(pending, true);
      }
    }

    private answer(pending: Pending, isResubscribe: boolean): void {
      const user =
        'user' in pending.subscription ? pending.subscription.user : '';
      const error = this.refusals.get(user) ?? null;
      if (error === null) {
        this.acknowledged.set(
          JSON.stringify(pending.subscription),
          pending.subscription,
        );
      } else {
        this.acknowledged.delete(JSON.stringify(pending.subscription));
      }
      const result = { subscription: pending.subscription, error };
      pending.resolve(result);
      if (isResubscribe) {
        this.options.onResubscribeResult?.(result);
      }
    }
  }

  return { ScriptedSocket };
});

const timing = vi.hoisted(() => ({ reconnectDelayMs: 5 }));

vi.mock('@remora/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@remora/sdk')>()),
  HyperliquidSocket: ScriptedSocket,
  reconnectDelayMs: () => timing.reconnectDelayMs,
}));

const TOKEN = 'collector-token-0123456789abcdef0123456789';
const WALLET_A = '0x1111111111111111111111111111111111111111';
const WALLET_B = '0x2222222222222222222222222222222222222222';
const WALLET_C = '0x3333333333333333333333333333333333333333';
const SINCE = 1_777_000_000_000;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFill(tid: number, time: number): HyperliquidFill {
  return {
    coin: 'ETH',
    px: '2701.2',
    sz: '0.5',
    side: 'B',
    time,
    startPosition: '0.0',
    dir: 'Open Long',
    closedPnl: '0.0',
    hash: '0x00',
    oid: tid,
    crossed: true,
    fee: '0.6',
    tid,
    feeToken: 'USDC',
    twapId: null,
  };
}

type InfoRequest = { type: string; user?: string; startTime?: number };

describe('WatchlistService', () => {
  let core: FakeCore;
  let service: WatchlistService | null;
  let infoRequests: InfoRequest[];
  let fillPages: Map<
    string,
    (HyperliquidFill[] | Promise<HyperliquidFill[]>)[]
  >;

  function socket(): InstanceType<typeof ScriptedSocket> {
    if (!ScriptedSocket.latest) {
      throw new Error('the service created no socket');
    }
    return ScriptedSocket.latest;
  }

  async function startService(maxWallets = 8): Promise<WatchlistService> {
    const config = new ConfigService<CollectorConfig, true>(
      validateCollectorConfig({
        CLUSTER_ID: '4',
        CLUSTER_TOKEN: TOKEN,
        CORE_URL: core.url,
        MAX_WALLETS: String(maxWallets),
        HYPERLIQUID_WS_URL: 'ws://127.0.0.1:9/ws',
        HYPERLIQUID_API_URL: 'http://127.0.0.1:9',
        HYPERLIQUID_WEIGHT_PER_MINUTE: '600000',
      }),
    );
    service = new WatchlistService(config);
    service.onApplicationBootstrap();
    await core.waitForFrame((frame) => frame.type === 'hello');
    return service;
  }

  function backfillStarts(user: string): number[] {
    return infoRequests
      .filter(
        (request) =>
          request.type === 'userFillsByTime' && request.user === user,
      )
      .map((request) => request.startTime ?? -1);
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

  function indexOf(
    predicate: (frame: CollectorMessage) => boolean,
    from = 0,
  ): number {
    const index = core.frames.slice(from).findIndex(predicate);
    return index < 0 ? -1 : index + from;
  }

  const isSynced = (wallet: string) => (frame: CollectorMessage) =>
    frame.type === 'synced' && frame.wallet === wallet;
  const isEvent =
    (wallet: string, source: string) => (frame: CollectorMessage) =>
      frame.type === 'event' &&
      frame.wallet === wallet &&
      frame.source === source;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  afterAll(() => {
    Logger.overrideLogger([
      'log',
      'error',
      'warn',
      'debug',
      'verbose',
      'fatal',
    ]);
  });

  beforeEach(async () => {
    ScriptedSocket.latest = null;
    timing.reconnectDelayMs = 5;
    service = null;
    infoRequests = [];
    fillPages = new Map();
    core = await FakeCore.start({ token: TOKEN });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body) as InfoRequest;
        infoRequests.push(request);
        if (request.type === 'portfolio') {
          return Response.json([
            ['day', { accountValueHistory: [], pnlHistory: [], vlm: '0.0' }],
          ]);
        }
        const page = fillPages.get(request.user ?? '')?.shift() ?? [];
        return Response.json(await page);
      }),
    );
  });

  afterEach(async () => {
    await service?.onApplicationShutdown();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await core.close();
    vi.unstubAllGlobals();
  });

  it('subscribes both channels of added wallets, unsubscribes removed ones and answers assigned', async () => {
    await startService();
    core.sendAssign([
      { address: WALLET_A, fillsSince: SINCE },
      { address: WALLET_B, fillsSince: SINCE },
    ]);
    await core.waitForFrame(
      (frame) => frame.type === 'assigned' && frame.version === 1,
    );
    expect(core.framesOf('assigned')[0]).toEqual({
      type: 'assigned',
      version: 1,
      subscribed: [WALLET_A, WALLET_B],
      failed: [],
    });
    expect(socket().requests).toEqual([
      {
        method: 'subscribe',
        subscription: { type: 'userFills', user: WALLET_A },
      },
      {
        method: 'subscribe',
        subscription: { type: 'clearinghouseState', user: WALLET_A },
      },
      {
        method: 'subscribe',
        subscription: { type: 'userFills', user: WALLET_B },
      },
      {
        method: 'subscribe',
        subscription: { type: 'clearinghouseState', user: WALLET_B },
      },
    ]);
    socket().requests.length = 0;
    core.sendAssign([
      { address: WALLET_B, fillsSince: SINCE },
      { address: WALLET_C, fillsSince: SINCE },
    ]);
    await core.waitForFrame(
      (frame) => frame.type === 'assigned' && frame.version === 2,
    );
    expect(core.framesOf('assigned')[1].subscribed).toEqual([
      WALLET_B,
      WALLET_C,
    ]);
    expect(socket().requests).toEqual([
      {
        method: 'unsubscribe',
        subscription: { type: 'userFills', user: WALLET_A },
      },
      {
        method: 'unsubscribe',
        subscription: { type: 'clearinghouseState', user: WALLET_A },
      },
      {
        method: 'subscribe',
        subscription: { type: 'userFills', user: WALLET_C },
      },
      {
        method: 'subscribe',
        subscription: { type: 'clearinghouseState', user: WALLET_C },
      },
    ]);
  });

  it('refuses wallets beyond MAX_WALLETS as over_capacity without subscribing them', async () => {
    await startService(2);
    core.sendAssign([
      { address: WALLET_A, fillsSince: SINCE },
      { address: WALLET_B, fillsSince: SINCE },
      { address: WALLET_C, fillsSince: SINCE },
    ]);
    await core.waitForFrame((frame) => frame.type === 'assigned');
    expect(core.framesOf('assigned')[0]).toMatchObject({
      subscribed: [WALLET_A, WALLET_B],
      failed: [{ address: WALLET_C, reason: 'over_capacity' }],
    });
    expect(
      socket().requests.some(
        (request) =>
          'user' in request.subscription &&
          request.subscription.user === WALLET_C,
      ),
    ).toBe(false);
  });

  it('marks a wallet that Hyperliquid refuses with Cannot track more than as user_limit', async () => {
    const watchlist = await startService();
    socket().refusals.set(WALLET_B, 'Cannot track more than 10 total users.');
    core.sendAssign([
      { address: WALLET_A, fillsSince: SINCE },
      { address: WALLET_B, fillsSince: SINCE },
    ]);
    await core.waitForFrame(isSynced(WALLET_A));
    expect(core.framesOf('assigned')[0]).toMatchObject({
      subscribed: [WALLET_A],
      failed: [{ address: WALLET_B, reason: 'user_limit' }],
    });
    expect(backfillStarts(WALLET_B)).toEqual([]);
    expect(watchlist.readHealth()).toMatchObject({
      isHealthy: true,
      wallets: [{ address: WALLET_A, isSubscribed: true, backfill: 'synced' }],
    });
  });

  it('backfills every wallet of the first assign of a session and only added wallets afterwards', async () => {
    await startService();
    core.sendAssign([
      { address: WALLET_A, fillsSince: SINCE },
      { address: WALLET_B, fillsSince: SINCE + 1 },
    ]);
    await core.waitForFrame(isSynced(WALLET_B));
    await core.waitForFrame(isSynced(WALLET_A));
    core.sendAssign([
      { address: WALLET_A, fillsSince: SINCE + 50 },
      { address: WALLET_B, fillsSince: SINCE + 50 },
      { address: WALLET_C, fillsSince: SINCE + 2 },
    ]);
    await core.waitForFrame(isSynced(WALLET_C));
    expect(backfillStarts(WALLET_A)).toEqual([SINCE]);
    expect(backfillStarts(WALLET_B)).toEqual([SINCE + 1]);
    expect(backfillStarts(WALLET_C)).toEqual([SINCE + 2]);
    const framesBefore = core.frames.length;
    core.dropSession();
    await core.waitForFrame(
      (frame) =>
        frame.type === 'hello' && core.frames.indexOf(frame) >= framesBefore,
    );
    core.sendAssign([
      { address: WALLET_A, fillsSince: SINCE + 10 },
      { address: WALLET_B, fillsSince: SINCE + 11 },
      { address: WALLET_C, fillsSince: SINCE + 12 },
    ]);
    await waitUntil(() => core.framesOf('synced').length === 6);
    expect(backfillStarts(WALLET_A)).toEqual([SINCE, SINCE + 10]);
    expect(backfillStarts(WALLET_B)).toEqual([SINCE + 1, SINCE + 11]);
    expect(backfillStarts(WALLET_C)).toEqual([SINCE + 2, SINCE + 12]);
  });

  it('forwards live frames as soon as assign arrives and starts the backfill only after the acknowledgement', async () => {
    await startService();
    const page = createDeferred<HyperliquidFill[]>();
    fillPages.set(WALLET_A, [page.promise]);
    socket().holdsAcknowledgements = true;
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await waitUntil(() => socket().pending.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backfillStarts(WALLET_A)).toEqual([]);
    socket().acknowledgePending();
    socket().emit('userFills', {
      isSnapshot: true,
      user: WALLET_A,
      fills: [createFill(1, SINCE + 5)],
    });
    await waitUntil(() => backfillStarts(WALLET_A).length === 1);
    socket().emit('userFills', {
      user: WALLET_A,
      fills: [createFill(2, SINCE + 9)],
    });
    socket().emit('clearinghouseState', {
      dex: '',
      user: WALLET_A,
      clearinghouseState: {
        marginSummary: {
          accountValue: '1.0',
          totalNtlPos: '0.0',
          totalRawUsd: '1.0',
          totalMarginUsed: '0.0',
        },
        crossMarginSummary: {
          accountValue: '1.0',
          totalNtlPos: '0.0',
          totalRawUsd: '1.0',
          totalMarginUsed: '0.0',
        },
        crossMaintenanceMarginUsed: '0.0',
        withdrawable: '1.0',
        assetPositions: [],
        time: SINCE + 9,
      },
    });
    await core.waitForFrame(
      (frame) =>
        frame.type === 'event' && frame.channel === 'clearinghouseState',
    );
    page.resolve([createFill(1, SINCE + 5), createFill(3, SINCE + 7)]);
    const syncedIndex = await core.waitForFrame(isSynced(WALLET_A));
    const snapshotIndex = indexOf(isEvent(WALLET_A, 'snapshot'));
    const streamIndex = indexOf(isEvent(WALLET_A, 'stream'));
    const backfillIndex = indexOf(isEvent(WALLET_A, 'backfill'));
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(snapshotIndex).toBeLessThan(streamIndex);
    expect(streamIndex).toBeLessThan(backfillIndex);
    expect(backfillIndex).toBe(syncedIndex - 1);
  });

  it('sends syncStarted before resubscribing after an upstream reconnect and backfills from the last fill sent', async () => {
    await startService();
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await core.waitForFrame(isSynced(WALLET_A));
    socket().emit('userFills', {
      user: WALLET_A,
      fills: [createFill(7, SINCE + 700), createFill(8, SINCE + 900)],
    });
    await core.waitForFrame(isEvent(WALLET_A, 'stream'));
    fillPages.set(WALLET_A, [
      [createFill(8, SINCE + 900), createFill(9, SINCE + 950)],
    ]);
    socket().disconnect();
    socket().reopen();
    const syncStartedIndex = await core.waitForFrame(
      (frame) => frame.type === 'syncStarted',
    );
    expect(core.frames[syncStartedIndex]).toEqual({
      type: 'syncStarted',
      wallets: [WALLET_A],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backfillStarts(WALLET_A)).toEqual([SINCE]);
    socket().acknowledgeResubscriptions();
    socket().emit('userFills', {
      isSnapshot: true,
      user: WALLET_A,
      fills: [createFill(8, SINCE + 900)],
    });
    const syncedIndex = await core.waitForFrame(
      (frame) =>
        frame.type === 'synced' &&
        core.frames.indexOf(frame) > syncStartedIndex,
    );
    expect(backfillStarts(WALLET_A)).toEqual([SINCE, SINCE + 900]);
    const snapshotIndex = indexOf(
      isEvent(WALLET_A, 'snapshot'),
      syncStartedIndex,
    );
    const backfillIndex = indexOf(
      isEvent(WALLET_A, 'backfill'),
      syncStartedIndex,
    );
    expect(syncStartedIndex).toBeLessThan(snapshotIndex);
    expect(snapshotIndex).toBeLessThan(backfillIndex);
    expect(backfillIndex).toBe(syncedIndex - 1);
  });

  it('restarts a backfill still running after an upstream reconnect from its own cursor', async () => {
    await startService();
    const fullPage = Array.from({ length: 2_000 }, (_, index) =>
      createFill(index + 1, SINCE + index),
    );
    const lostPage = createDeferred<HyperliquidFill[]>();
    fillPages.set(WALLET_A, [
      fullPage,
      lostPage.promise,
      [createFill(2_000, SINCE + 1_999), createFill(2_001, SINCE + 2_000)],
    ]);
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await waitUntil(() => backfillStarts(WALLET_A).length === 2);
    socket().disconnect();
    socket().reopen();
    socket().acknowledgeResubscriptions();
    await waitUntil(() => backfillStarts(WALLET_A).length === 3);
    expect(backfillStarts(WALLET_A)).toEqual([
      SINCE,
      SINCE + 1_999,
      SINCE + 1_999,
    ]);
    await core.waitForFrame(isSynced(WALLET_A));
    lostPage.resolve([createFill(9_999, SINCE + 5_000)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const backfills = core
      .framesOf('event')
      .filter((frame) => frame.source === 'backfill');
    const sentTids = backfills.flatMap((frame) =>
      frame.payload.map((fill) => fill.tid),
    );
    expect(backfills).toHaveLength(2);
    expect(sentTids).toContain(2_001);
    expect(sentTids).not.toContain(9_999);
    expect(core.framesOf('synced')).toHaveLength(1);
  });

  it('skips the resync while the core link is down', async () => {
    const watchlist = await startService();
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await core.waitForFrame(isSynced(WALLET_A));
    timing.reconnectDelayMs = 60_000;
    core.dropSession();
    await waitUntil(() => watchlist.readHealth().coreLink === 'closed');
    const framesBefore = core.frames.length;
    socket().disconnect();
    socket().reopen();
    socket().acknowledgeResubscriptions();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(core.frames.length).toBe(framesBefore);
    expect(backfillStarts(WALLET_A)).toEqual([SINCE]);
    expect(watchlist.readStats().wallets[0].backfill).toBe('pending');
  });

  function backfilledTids(wallet: string): number[] {
    return core
      .framesOf('event')
      .filter((frame) => frame.wallet === wallet && frame.source === 'backfill')
      .flatMap((frame) =>
        (frame.payload as HyperliquidFill[]).map((fill) => fill.tid),
      );
  }

  function streamedTids(wallet: string): number[] {
    return core
      .framesOf('event')
      .filter((frame) => frame.wallet === wallet && frame.source === 'stream')
      .flatMap((frame) =>
        (frame.payload as { fills: HyperliquidFill[] }).fills.map(
          (fill) => fill.tid,
        ),
      );
  }

  async function dropLinkWhile(
    watchlist: WatchlistService,
    whileDown: () => void,
  ): Promise<void> {
    timing.reconnectDelayMs = 300;
    core.dropSession();
    await waitUntil(() => watchlist.readHealth().coreLink === 'closed');
    whileDown();
    await core.waitForFrame(
      (frame) => frame.type === 'hello' && core.framesOf('hello').length === 2,
    );
    timing.reconnectDelayMs = 5;
  }

  it('drops events while the link is down and sends synced only once REST returns them', async () => {
    const watchlist = await startService();
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await core.waitForFrame(isSynced(WALLET_A));
    const dropped = createFill(77, SINCE + 77);
    await dropLinkWhile(watchlist, () =>
      socket().emit('userFills', { user: WALLET_A, fills: [dropped] }),
    );
    fillPages.set(WALLET_A, [[], [dropped]]);
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE + 40 }]);
    await waitUntil(() => core.framesOf('synced').length === 2);
    const synced = core.frames.indexOf(core.framesOf('synced')[1]);
    expect(streamedTids(WALLET_A)).toEqual([]);
    expect(backfilledTids(WALLET_A)).toEqual([77]);
    expect(backfillStarts(WALLET_A)).toEqual([SINCE, SINCE + 40, SINCE + 40]);
    expect(lastIndexOf(isEvent(WALLET_A, 'backfill'))).toBeLessThan(synced);
  });

  it('forwards nothing of a new session before its first assign and backfills what it held back', async () => {
    await startService();
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await core.waitForFrame(isSynced(WALLET_A));
    core.dropSession();
    await core.waitForFrame(
      (frame) => frame.type === 'hello' && core.framesOf('hello').length === 2,
    );
    const heldBack = createFill(78, SINCE + 78);
    socket().emit('userFills', { user: WALLET_A, fills: [heldBack] });
    fillPages.set(WALLET_A, [[heldBack]]);
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE + 40 }]);
    await waitUntil(() => core.framesOf('synced').length === 2);
    socket().emit('userFills', {
      user: WALLET_A,
      fills: [createFill(79, SINCE + 79)],
    });
    await core.waitForFrame(isEvent(WALLET_A, 'stream'));
    expect(streamedTids(WALLET_A)).toEqual([79]);
    expect(backfilledTids(WALLET_A)).toEqual([78]);
    expect(backfillStarts(WALLET_A)).toEqual([SINCE, SINCE + 40]);
  });

  it('waits for REST to reach the oldest fill of the snapshot after an upstream reconnect', async () => {
    await startService();
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await core.waitForFrame(isSynced(WALLET_A));
    socket().emit('userFills', {
      user: WALLET_A,
      fills: [createFill(7, SINCE + 700)],
    });
    await core.waitForFrame(isEvent(WALLET_A, 'stream'));
    const gapFill = createFill(15, SINCE + 1_500);
    const snapshotFills = [
      createFill(20, SINCE + 2_000),
      createFill(21, SINCE + 2_100),
    ];
    fillPages.set(WALLET_A, [
      [createFill(7, SINCE + 700)],
      [createFill(7, SINCE + 700), gapFill, snapshotFills[0]],
    ]);
    socket().disconnect();
    socket().reopen();
    const syncStarted = await core.waitForFrame(
      (frame) => frame.type === 'syncStarted',
    );
    socket().acknowledgeResubscriptions();
    socket().emit('userFills', {
      isSnapshot: true,
      user: WALLET_A,
      fills: snapshotFills,
    });
    const synced = await core.waitForFrame(
      (frame) =>
        frame.type === 'synced' && core.frames.indexOf(frame) > syncStarted,
    );
    expect(backfillStarts(WALLET_A)).toEqual([SINCE, SINCE + 700, SINCE + 700]);
    expect(backfilledTids(WALLET_A)).toContain(15);
    expect(lastIndexOf(isEvent(WALLET_A, 'backfill'))).toBeLessThan(synced);
  });

  it('syncs anyway and reports lagging once REST stays behind for the lag limit', async () => {
    const watchlist = await startService();
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await core.waitForFrame(isSynced(WALLET_A));
    await dropLinkWhile(watchlist, () =>
      socket().emit('userFills', {
        user: WALLET_A,
        fills: [createFill(90, SINCE + 900)],
      }),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now());
    const fetchStub = vi.mocked(fetch);
    const answerInfo = fetchStub.getMockImplementation();
    fetchStub.mockImplementation((url, init) => {
      vi.setSystemTime(Date.now() + 50_000);
      return answerInfo
        ? answerInfo(url, init)
        : Promise.reject(new Error('no stub'));
    });
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE + 40 }]);
    await waitUntil(
      () => core.framesOf('synced').length === 2,
      10_000,
      'a lagging sync',
    );
    vi.useRealTimers();
    expect(watchlist.readStats().wallets[0].backfill).toBe('lagging');
    expect(backfilledTids(WALLET_A)).toEqual([]);
  });

  it('syncs a wallet with nothing held back after a single read', async () => {
    await startService();
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await core.waitForFrame(isSynced(WALLET_A));
    socket().disconnect();
    socket().reopen();
    socket().acknowledgeResubscriptions();
    await waitUntil(() => core.framesOf('synced').length === 2);
    expect(backfillStarts(WALLET_A)).toEqual([SINCE, SINCE]);
  });

  it('reports a wallet refused on resubscription with an assigned for the current version', async () => {
    await startService();
    core.sendAssign([
      { address: WALLET_A, fillsSince: SINCE },
      { address: WALLET_B, fillsSince: SINCE },
    ]);
    await core.waitForFrame(isSynced(WALLET_B));
    socket().disconnect();
    socket().reopen();
    socket().refusals.set(WALLET_B, 'Cannot track more than 10 total users.');
    socket().acknowledgeResubscriptions();
    await waitUntil(() => core.framesOf('assigned').length === 2);
    expect(core.framesOf('assigned')[1]).toEqual({
      type: 'assigned',
      version: 1,
      subscribed: [WALLET_A],
      failed: [{ address: WALLET_B, reason: 'user_limit' }],
    });
  });

  it('forwards each portfolio poll with source poll and reports wallet state in the stats', async () => {
    const watchlist = await startService();
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await core.waitForFrame(
      (frame) => frame.type === 'event' && frame.channel === 'portfolio',
    );
    await core.waitForFrame(isSynced(WALLET_A));
    expect(
      core.framesOf('event').find((frame) => frame.channel === 'portfolio'),
    ).toMatchObject({
      wallet: WALLET_A,
      source: 'poll',
    });
    const stats = watchlist.readStats();
    expect(stats.wallets).toEqual([
      {
        address: WALLET_A,
        subscribedAt: expect.any(Number) as number,
        lastEventAt: null,
        backfill: 'synced',
      },
    ]);
    expect(stats.weightUsedLastMinute).toBe(40);
  });

  it('is healthy only while the core link is open and every wallet is subscribed', async () => {
    const watchlist = await startService();
    core.sendAssign([{ address: WALLET_A, fillsSince: SINCE }]);
    await core.waitForFrame(isSynced(WALLET_A));
    expect(watchlist.readHealth().isHealthy).toBe(true);
    socket().disconnect();
    expect(watchlist.readHealth()).toMatchObject({
      isHealthy: false,
      upstream: 'closed',
    });
    socket().reopen();
    socket().acknowledgeResubscriptions();
    expect(watchlist.readHealth().isHealthy).toBe(true);
    core.dropSession();
    await waitUntil(() => !watchlist.readHealth().isHealthy);
  });
});
