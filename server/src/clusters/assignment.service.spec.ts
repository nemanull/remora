import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AssignMessage } from '@remora/sdk';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import WebSocket from 'ws';
import type { ServerConfig } from '../config';
import { CopyEvents, type CopyEvent } from '../copy/copyEvents';
import type { SyncStateService } from '../ingestion/syncState.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AssignmentService } from './assignment.service';
import type {
  ClusterRegistryService,
  ClusterSession,
} from './clusterRegistry.service';
import type { AssignmentCluster } from './walletAssignment';

const NOW = new Date('2026-04-20T12:00:00.000Z');
const WATERMARKED = '0x000000000000000000000000000000000000000a';
const NEW_SHADOW = '0x000000000000000000000000000000000000000b';
const RETIRED = '0x000000000000000000000000000000000000000c';

type Row = {
  address: string;
  status: 'CANDIDATE' | 'SHADOW' | 'LIVE' | 'RETIRED';
  source: 'LEADERBOARD' | 'MANUAL';
  score: number | null;
  trackedSince: Date | null;
  fillsSyncedUntil: Date | null;
  clusterId: number | null;
  positions: { id: bigint }[];
};

function row(address: string, overrides: Partial<Row> = {}): Row {
  return {
    address,
    status: 'SHADOW',
    source: 'LEADERBOARD',
    score: 0.5,
    trackedSince: null,
    fillsSyncedUntil: null,
    clusterId: null,
    positions: [],
    ...overrides,
  };
}

function createSession(clusterId: number): {
  session: ClusterSession;
  sent: AssignMessage[];
} {
  const sent: AssignMessage[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => sent.push(JSON.parse(data) as AssignMessage),
  } as unknown as WebSocket;
  return {
    session: {
      key: clusterId * 10,
      clusterId,
      socket,
      collectorSessionId: '11111111-1111-4111-8111-111111111111',
      maxWallets: 8,
      version: '0.0.1',
      connectedAt: NOW,
      assignedWallets: null,
    },
    sent,
  };
}

describe('AssignmentService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  let rows: Row[];
  let versions: Map<number, number>;
  let sessions: ClusterSession[];
  let subscribed: Set<string>;
  let published: CopyEvent[];
  let prisma: {
    wallet: {
      findMany: Mock<() => Promise<Row[]>>;
      update: ReturnType<typeof vi.fn>;
    };
    cluster: { update: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let syncState: {
    markAssigned: ReturnType<typeof vi.fn>;
    markAssignApplied: ReturnType<typeof vi.fn>;
  };
  let registry: {
    listAssignmentClusters: ReturnType<typeof vi.fn>;
    listSessions: () => ClusterSession[];
    readSession: (clusterId: number) => ClusterSession | null;
    readSubscribedWallets: () => Set<string>;
    recordAssigned: ReturnType<typeof vi.fn>;
  };
  let service: AssignmentService;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    rows = [];
    versions = new Map();
    sessions = [];
    subscribed = new Set();
    prisma = {
      wallet: {
        findMany: vi.fn<() => Promise<Row[]>>(() =>
          Promise.resolve(rows.map((entry) => ({ ...entry }))),
        ),
        update: vi.fn(
          ({
            where,
            data,
          }: {
            where: { address: string };
            data: Partial<Row>;
          }) => {
            const target = rows.find(
              (entry) => entry.address === where.address,
            );
            Object.assign(target ?? {}, data);
            return { address: where.address };
          },
        ),
      },
      cluster: {
        update: vi.fn(({ where }: { where: { id: number } }) => {
          const version = (versions.get(where.id) ?? 0) + 1;
          versions.set(where.id, version);
          return { id: where.id, assignVersion: version };
        }),
      },
      $transaction: vi.fn((operations: unknown[]) =>
        Promise.resolve(operations),
      ),
    };
    syncState = { markAssigned: vi.fn(), markAssignApplied: vi.fn() };
    registry = {
      listAssignmentClusters: vi.fn((): AssignmentCluster[] =>
        sessions.map((session) => ({
          id: session.clusterId,
          isOnline: true,
          capacity: 8,
          offlineSince: null,
          refusedWallets: new Set(),
        })),
      ),
      listSessions: () => sessions,
      readSession: (clusterId) =>
        sessions.find((session) => session.clusterId === clusterId) ?? null,
      readSubscribedWallets: () => subscribed,
      recordAssigned: vi.fn(),
    };
    const events = new CopyEvents();
    published = [];
    events.events$.subscribe((event) => published.push(event));
    const config = {
      getOrThrow: () => 30_000,
    } as unknown as ConfigService<ServerConfig, true>;
    service = new AssignmentService(
      prisma as unknown as PrismaService,
      registry as unknown as ClusterRegistryService,
      syncState as unknown as SyncStateService,
      events,
      config,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  async function runAssignment(reason = 'test'): Promise<void> {
    service.requestAssignment(reason);
    await vi.waitFor(() => expect(prisma.wallet.findMany).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(0);
  }

  it('sends the first assign of a session with each wallet backfill cursor', async () => {
    const trackedSince = new Date('2026-04-01T00:00:00.000Z');
    const watermark = new Date('2026-04-19T08:00:00.000Z');
    rows = [
      row(WATERMARKED, {
        trackedSince,
        fillsSyncedUntil: watermark,
        clusterId: 1,
      }),
      row(NEW_SHADOW),
    ];
    const { session, sent } = createSession(1);
    sessions = [session];

    await runAssignment();

    expect(sent).toEqual([
      {
        type: 'assign',
        version: 1,
        wallets: [
          { address: WATERMARKED, fillsSince: watermark.getTime() },
          { address: NEW_SHADOW, fillsSince: NOW.getTime() },
        ],
      },
    ]);
    expect(rows[1]).toMatchObject({ clusterId: 1, trackedSince: NOW });
    expect(syncState.markAssigned).toHaveBeenCalledWith(session.key, 1, [
      {
        address: WATERMARKED,
        trackedSince,
        fillsSince: watermark.getTime(),
      },
      { address: NEW_SHADOW, trackedSince: NOW, fillsSince: NOW.getTime() },
    ]);
  });

  it('starts a backfill at tracked_since when the watermark is older', async () => {
    const trackedSince = new Date('2026-04-10T00:00:00.000Z');
    rows = [
      row(WATERMARKED, {
        trackedSince,
        fillsSyncedUntil: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ];
    const { session, sent } = createSession(1);
    sessions = [session];

    await runAssignment();

    expect(sent[0].wallets).toEqual([
      { address: WATERMARKED, fillsSince: trackedSince.getTime() },
    ]);
  });

  it('sends nothing when the assignment did not change', async () => {
    rows = [row(WATERMARKED, { trackedSince: NOW })];
    const { session, sent } = createSession(1);
    sessions = [session];
    await runAssignment();

    prisma.wallet.findMany.mockClear();
    await runAssignment();

    expect(sent).toHaveLength(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('removes a wallet that is no longer tracked from its collector', async () => {
    rows = [
      row(WATERMARKED, { trackedSince: NOW, clusterId: 1 }),
      row(RETIRED, { status: 'RETIRED', trackedSince: NOW, clusterId: 1 }),
    ];
    const { session, sent } = createSession(1);
    session.assignedWallets = [WATERMARKED, RETIRED];
    sessions = [session];

    await runAssignment();

    expect(sent).toEqual([
      expect.objectContaining({
        version: 1,
        wallets: [{ address: WATERMARKED, fillsSince: NOW.getTime() }],
      }),
    ]);
    expect(rows[1].clusterId).toBeNull();
  });

  it('runs one assignment at a time and repeats once for requests made meanwhile', async () => {
    let releaseFirst: () => void = () => undefined;
    prisma.wallet.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve([]);
        }),
    );

    service.requestAssignment('first');
    service.requestAssignment('second');
    service.requestAssignment('third');
    expect(prisma.wallet.findMany).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);

    expect(prisma.wallet.findMany).toHaveBeenCalledTimes(2);
  });

  it('marks the version applied and reassigns after a collector refused wallets', async () => {
    const { session } = createSession(1);
    const assigned = {
      type: 'assigned' as const,
      version: 4,
      subscribed: [WATERMARKED],
      failed: [{ address: NEW_SHADOW, reason: 'user_limit' }],
    };

    service.handleAssigned(session, assigned);

    expect(syncState.markAssignApplied).toHaveBeenCalledWith(session.key, 4);
    expect(registry.recordAssigned).toHaveBeenCalledWith(session, assigned);
    await vi.waitFor(() =>
      expect(prisma.wallet.findMany).toHaveBeenCalledTimes(1),
    );
  });

  it('treats a repeated assigned as the same acknowledgement', async () => {
    rows = [row(WATERMARKED, { trackedSince: NOW })];
    const { session, sent } = createSession(1);
    sessions = [session];
    await runAssignment();
    const assigned = {
      type: 'assigned' as const,
      version: 1,
      subscribed: [WATERMARKED],
      failed: [],
    };

    service.handleAssigned(session, assigned);
    service.handleAssigned(session, assigned);
    await vi.advanceTimersByTimeAsync(0);

    expect(syncState.markAssigned).toHaveBeenCalledTimes(1);
    expect(syncState.markAssignApplied.mock.calls).toEqual([
      [session.key, 1],
      [session.key, 1],
    ]);
    expect(prisma.wallet.findMany).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('alerts once for a tracked wallet without a subscription for two minutes', async () => {
    rows = [row(WATERMARKED, { trackedSince: NOW })];
    sessions = [createSession(1).session];

    await runAssignment();
    vi.setSystemTime(NOW.getTime() + 90_000);
    await runAssignment();
    expect(published.filter((event) => event.type === 'alert')).toHaveLength(0);

    vi.setSystemTime(NOW.getTime() + 121_000);
    await runAssignment();
    vi.setSystemTime(NOW.getTime() + 150_000);
    await runAssignment();

    expect(published).toEqual([
      expect.objectContaining({
        type: 'alert',
        code: 'wallet_unsubscribed',
        wallet: WATERMARKED,
        clusterId: 1,
      }),
    ]);

    subscribed.add(WATERMARKED);
    await runAssignment();
    subscribed.clear();
    vi.setSystemTime(NOW.getTime() + 400_000);
    await runAssignment();

    expect(published).toHaveLength(1);
  });
});
