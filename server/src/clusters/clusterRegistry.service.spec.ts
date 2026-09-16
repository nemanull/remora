import type {
  CollectorStats,
  CollectorWalletStats,
  HelloMessage,
} from '@remora/sdk';
import { Logger } from '@nestjs/common';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { WebSocket } from 'ws';
import { CopyEvents, type CopyEvent } from '../copy/copyEvents';
import { MetricsService } from '../metrics/metrics.service';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ClusterRegistryService,
  type ClusterSession,
} from './clusterRegistry.service';

const WALLET = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';
const START = new Date('2026-04-20T12:00:00.000Z');

let nextKey = 1;

function createSession(
  collectorSessionId: string,
  clusterId = 1,
): { session: ClusterSession; hello: HelloMessage } {
  const session: ClusterSession = {
    key: nextKey,
    clusterId,
    socket: {} as WebSocket,
    collectorSessionId,
    maxWallets: 8,
    version: '0.0.1',
    connectedAt: new Date(),
    assignedWallets: null,
  };
  nextKey += 1;
  return {
    session,
    hello: {
      type: 'hello',
      protocolVersion: 1,
      clusterId,
      sessionId: collectorSessionId,
      maxWallets: 8,
      version: '0.0.1',
    },
  };
}

function stats(
  overrides: Partial<CollectorStats> = {},
  wallets: Partial<CollectorWalletStats>[] = [],
): CollectorStats {
  return {
    upstreamState: 'open',
    upstreamConnectedAt: START.getTime(),
    upstreamReconnects: 0,
    pingRoundTripMs: 120,
    clockOffsetMs: 2,
    eventLoopDelayP99Ms: 11,
    rssBytes: 90_000_000,
    weightUsedLastMinute: 40,
    wallets: wallets.map((wallet) => ({
      address: WALLET,
      subscribedAt: START.getTime(),
      lastEventAt: START.getTime(),
      backfill: 'synced',
      ...wallet,
    })),
    ...overrides,
  };
}

describe('ClusterRegistryService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  let registry: ClusterRegistryService;
  let metrics: MetricsService;
  let published: CopyEvent[];
  let upsertCluster: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers({ now: START });
    upsertCluster = vi.fn().mockResolvedValue({});
    const prisma = {
      cluster: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: upsertCluster,
        update: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const events = new CopyEvents();
    published = [];
    events.events$.subscribe((event) => published.push(event));
    metrics = new MetricsService();
    registry = new ClusterRegistryService(prisma, metrics, events);
    await registry.onModuleInit();
  });

  afterEach(() => {
    registry.onModuleDestroy();
    vi.useRealTimers();
  });

  function heartbeat(session: ClusterSession, collectorStats: CollectorStats) {
    registry.recordHeartbeat(session, {
      type: 'heartbeat',
      sentAt: Date.now(),
      stats: collectorStats,
    });
  }

  function alerts(code: string) {
    return published.filter(
      (event) => event.type === 'alert' && event.code === code,
    );
  }

  async function readReconnects(): Promise<number> {
    const metric = await metrics.collectorUpstreamReconnectsTotal.get();
    return (
      metric.values.find((value) => value.labels.cluster === '1')?.value ?? 0
    );
  }

  it('counts upstream reconnects as the change within one collector process', async () => {
    const first = createSession('11111111-1111-4111-8111-111111111111');
    await registry.openSession(first.session, first.hello);
    heartbeat(first.session, stats({ upstreamReconnects: 2 }));
    heartbeat(first.session, stats({ upstreamReconnects: 3 }));
    registry.closeSession(first.session);

    const sameProcess = createSession('11111111-1111-4111-8111-111111111111');
    await registry.openSession(sameProcess.session, sameProcess.hello);
    heartbeat(sameProcess.session, stats({ upstreamReconnects: 5 }));
    registry.closeSession(sameProcess.session);

    const restarted = createSession('22222222-2222-4222-8222-222222222222');
    await registry.openSession(restarted.session, restarted.hello);
    heartbeat(restarted.session, stats({ upstreamReconnects: 1 }));

    await expect(readReconnects()).resolves.toBe(6);
  });

  it('raises the clock offset alert once per occurrence', async () => {
    const { session, hello } = createSession(
      '11111111-1111-4111-8111-111111111111',
    );
    await registry.openSession(session, hello);

    heartbeat(session, stats({ clockOffsetMs: 80 }));
    heartbeat(session, stats({ clockOffsetMs: -75 }));
    heartbeat(session, stats({ clockOffsetMs: 10 }));
    heartbeat(session, stats({ clockOffsetMs: 60 }));

    expect(alerts('clock_offset')).toHaveLength(2);
  });

  it('raises the truncated backfill alert once while the state lasts', async () => {
    const { session, hello } = createSession(
      '11111111-1111-4111-8111-111111111111',
    );
    await registry.openSession(session, hello);

    heartbeat(session, stats({}, [{ backfill: 'truncated' }]));
    heartbeat(session, stats({}, [{ backfill: 'truncated' }]));

    expect(alerts('backfill_truncated')).toEqual([
      expect.objectContaining({ wallet: WALLET, clusterId: 1 }),
    ]);
  });

  it('raises the lagging backfill alert once per occurrence', async () => {
    const { session, hello } = createSession(
      '11111111-1111-4111-8111-111111111111',
    );
    await registry.openSession(session, hello);

    heartbeat(session, stats({}, [{ backfill: 'lagging' }]));
    heartbeat(session, stats({}, [{ backfill: 'lagging' }]));
    heartbeat(session, stats({}, [{ backfill: 'running' }]));
    heartbeat(session, stats({}, [{ backfill: 'synced' }]));
    heartbeat(session, stats({}, [{ backfill: 'lagging' }]));

    expect(alerts('backfill_lagging')).toEqual([
      expect.objectContaining({
        code: 'backfill_lagging',
        wallet: WALLET,
        clusterId: 1,
      }),
      expect.objectContaining({
        code: 'backfill_lagging',
        wallet: WALLET,
        clusterId: 1,
      }),
    ]);
    expect(alerts('backfill_truncated')).toHaveLength(0);
  });

  it('raises the failed backfill alert once a wallet has retried for a minute', async () => {
    const { session, hello } = createSession(
      '11111111-1111-4111-8111-111111111111',
    );
    await registry.openSession(session, hello);

    heartbeat(session, stats({}, [{ backfill: 'retrying' }]));
    vi.advanceTimersByTime(50_000);
    heartbeat(session, stats({}, [{ backfill: 'retrying' }]));
    expect(alerts('backfill_failed')).toHaveLength(0);

    vi.advanceTimersByTime(10_000);
    heartbeat(session, stats({}, [{ backfill: 'retrying' }]));
    heartbeat(session, stats({}, [{ backfill: 'retrying' }]));

    expect(alerts('backfill_failed')).toHaveLength(1);
  });

  it('raises the silent collector alert once after a minute without heartbeat', async () => {
    const { session, hello } = createSession(
      '11111111-1111-4111-8111-111111111111',
    );
    await registry.openSession(session, hello);
    heartbeat(session, stats());
    registry.closeSession(session);

    vi.advanceTimersByTime(55_000);
    expect(alerts('collector_silent')).toHaveLength(0);
    vi.advanceTimersByTime(10_000);
    vi.advanceTimersByTime(30_000);

    expect(alerts('collector_silent')).toEqual([
      expect.objectContaining({ clusterId: 1, wallet: null }),
    ]);
  });

  it('lowers the capacity to the subscribed wallets when Hyperliquid refuses users', async () => {
    const { session, hello } = createSession(
      '11111111-1111-4111-8111-111111111111',
    );
    await registry.openSession(session, hello);

    registry.recordAssigned(session, {
      type: 'assigned',
      version: 3,
      subscribed: ['0x0000000000000000000000000000000000000001'],
      failed: [{ address: WALLET, reason: 'user_limit' }],
    });

    expect(registry.listAssignmentClusters([])).toEqual([
      expect.objectContaining({
        id: 1,
        isOnline: true,
        capacity: 1,
        refusedWallets: new Set([WALLET]),
      }),
    ]);
  });

  it('changes the capacity once when the same assigned arrives twice', async () => {
    const { session, hello } = createSession(
      '11111111-1111-4111-8111-111111111111',
    );
    await registry.openSession(session, hello);
    const assigned = {
      type: 'assigned' as const,
      version: 3,
      subscribed: [
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ],
      failed: [{ address: WALLET, reason: 'user_limit' }],
    };

    registry.recordAssigned(session, assigned);
    registry.recordAssigned(session, assigned);
    registry.recordAssigned(session, { ...assigned, failed: [] });

    expect(registry.listAssignmentClusters([])).toEqual([
      expect.objectContaining({
        capacity: 2,
        refusedWallets: new Set([WALLET]),
      }),
    ]);
  });

  it('marks a closed cluster offline from the moment it closed', async () => {
    const { session, hello } = createSession(
      '11111111-1111-4111-8111-111111111111',
    );
    await registry.openSession(session, hello);
    vi.advanceTimersByTime(5_000);

    expect(registry.closeSession(session)).toBe(true);
    expect(registry.closeSession(session)).toBe(false);

    expect(registry.listAssignmentClusters([4])).toEqual([
      expect.objectContaining({
        id: 1,
        isOnline: false,
        offlineSince: new Date(START.getTime() + 5_000),
      }),
      expect.objectContaining({ id: 4, isOnline: false, capacity: 0 }),
    ]);
    expect(
      published
        .filter((event) => event.type === 'collector')
        .map((event) => event.type === 'collector' && event.change),
    ).toEqual(['connected', 'disconnected']);
  });

  it('reads the wallets every online collector has subscribed', async () => {
    const { session, hello } = createSession(
      '11111111-1111-4111-8111-111111111111',
    );
    await registry.openSession(session, hello);

    heartbeat(
      session,
      stats({}, [
        { address: WALLET },
        {
          address: '0x0000000000000000000000000000000000000002',
          subscribedAt: null,
        },
      ]),
    );

    expect(registry.readSubscribedWallets()).toEqual(new Set([WALLET]));
  });

  it('starts a new session without the stats of the previous one', async () => {
    const first = createSession('11111111-1111-4111-8111-111111111111');
    await registry.openSession(first.session, first.hello);
    heartbeat(first.session, stats({}, [{ address: WALLET }]));
    registry.closeSession(first.session);

    const second = createSession('22222222-2222-4222-8222-222222222222');
    await registry.openSession(second.session, second.hello);

    expect(registry.readLastStats(1)).toBeNull();
    expect(registry.readSubscribedWallets()).toEqual(new Set());
    const [lastUpsert] = upsertCluster.mock.lastCall as [
      { update: { lastStats: unknown } },
    ];
    expect(lastUpsert.update.lastStats).toBe(Prisma.DbNull);
    expect(published.at(-1)).toMatchObject({
      type: 'collector',
      change: 'connected',
      stats: null,
    });
  });
});
