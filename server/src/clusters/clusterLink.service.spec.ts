import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { HyperliquidFill } from '@remora/sdk';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import WebSocket from 'ws';
import { CopyEvents } from '../copy/copyEvents';
import { Prisma } from '../generated/prisma/client';
import {
  FillIngestionService,
  type UserFillsEvent,
} from '../ingestion/fillIngestion.service';
import { LeaderStateService } from '../ingestion/leaderState.service';
import { SyncStateService } from '../ingestion/syncState.service';
import { MarketDataService } from '../market/marketData.service';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { AssignmentService } from './assignment.service';
import { ClusterLinkService } from './clusterLink.service';
import { ClusterRegistryService } from './clusterRegistry.service';

const WALLET = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';
const TOKEN_ONE = randomBytes(32).toString('hex');
const TOKEN_TWO = randomBytes(32).toString('hex');

type Client = {
  socket: WebSocket;
  frames: Record<string, unknown>[];
  closed: Promise<{ code: number; reason: string }>;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hello(clusterId: number) {
  return {
    type: 'hello',
    protocolVersion: 1,
    clusterId,
    sessionId: randomUUID(),
    maxWallets: 8,
    version: '0.0.1',
  };
}

function fillEvent(tid: number) {
  const fill: HyperliquidFill = {
    coin: 'BTC',
    px: '80000',
    sz: '0.01',
    side: 'B',
    time: 1_770_000_000_000 + tid,
    startPosition: '0',
    dir: 'Open Long',
    closedPnl: '0',
    hash: '0x00',
    oid: tid,
    crossed: true,
    fee: '0.36',
    tid,
    feeToken: 'USDC',
    twapId: null,
  };
  return {
    type: 'event',
    wallet: WALLET,
    channel: 'userFills',
    source: 'stream',
    receivedAt: fill.time + 250,
    payload: { user: WALLET, fills: [fill] },
  };
}

function readTid(event: UserFillsEvent): number {
  return event.source === 'backfill'
    ? event.payload[0].tid
    : event.payload.fills[0].tid;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ClusterLinkService', () => {
  let app: INestApplication;
  let url: string;
  let hasMarkets: boolean;
  let ingestFills: Mock<FillIngestionService['ingestFills']>;
  let assignment: {
    requestAssignment: Mock<AssignmentService['requestAssignment']>;
    requestAssignmentAfterGrace: Mock<
      AssignmentService['requestAssignmentAfterGrace']
    >;
    handleAssigned: Mock<AssignmentService['handleAssigned']>;
  };
  const clients: Client[] = [];

  beforeEach(async () => {
    hasMarkets = true;
    ingestFills = vi
      .fn<FillIngestionService['ingestFills']>()
      .mockResolvedValue(undefined);
    assignment = {
      requestAssignment: vi.fn<AssignmentService['requestAssignment']>(),
      requestAssignmentAfterGrace:
        vi.fn<AssignmentService['requestAssignmentAfterGrace']>(),
      handleAssigned: vi.fn<AssignmentService['handleAssigned']>(),
    };
    const prisma = {
      cluster: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const config: Record<string, unknown> = {
      CLUSTER_TOKEN_HASHES: [
        { clusterId: 1, tokenHash: hashToken(TOKEN_ONE) },
        { clusterId: 2, tokenHash: hashToken(TOKEN_TWO) },
      ],
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ClusterLinkService,
        ClusterRegistryService,
        { provide: PrismaService, useValue: prisma },
        { provide: MetricsService, useValue: new MetricsService() },
        { provide: CopyEvents, useValue: new CopyEvents() },
        { provide: AssignmentService, useValue: assignment },
        { provide: FillIngestionService, useValue: { ingestFills } },
        {
          provide: SyncStateService,
          useValue: {
            endSession: vi.fn(),
            markSyncStarted: vi.fn(),
            completeSync: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: LeaderStateService,
          useValue: {
            applyClearinghouseState: vi.fn(),
            applyPortfolio: vi.fn(),
          },
        },
        {
          provide: MarketDataService,
          useValue: { hasMarkets: () => hasMarkets },
        },
        {
          provide: ConfigService,
          useValue: { getOrThrow: (key: string) => config[key] },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/cluster`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.socket.terminate();
    }
    await app.close();
  });

  function connect(token: string): Promise<Client> {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const frames: Record<string, unknown>[] = [];
    socket.on('message', (data) =>
      frames.push(
        JSON.parse((data as Buffer).toString('utf8')) as Record<
          string,
          unknown
        >,
      ),
    );
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.on('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      ),
    );
    const client = { socket, frames, closed };
    clients.push(client);
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(client));
      socket.once('error', reject);
    });
  }

  function readUpgradeStatus(headers: Record<string, string>): Promise<number> {
    return new Promise((resolve) => {
      const socket = new WebSocket(url, { headers });
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.on('error', () => undefined);
    });
  }

  function send(client: Client, frame: unknown): void {
    client.socket.send(JSON.stringify(frame));
  }

  it('answers 401 before the upgrade for a missing or unknown token', async () => {
    await expect(readUpgradeStatus({})).resolves.toBe(401);
    await expect(
      readUpgradeStatus({
        Authorization: `Bearer ${randomBytes(32).toString('hex')}`,
      }),
    ).resolves.toBe(401);
  });

  it('answers 503 until the markets are loaded', async () => {
    hasMarkets = false;

    await expect(
      readUpgradeStatus({ Authorization: `Bearer ${TOKEN_ONE}` }),
    ).resolves.toBe(503);
  });

  it('closes with 4000 when hello names another cluster than the token', async () => {
    const client = await connect(TOKEN_ONE);

    send(client, hello(2));

    await expect(client.closed).resolves.toEqual({
      code: 4000,
      reason: 'protocol_error',
    });
  });

  it('closes with 4000 when a frame comes before hello', async () => {
    const client = await connect(TOKEN_ONE);

    send(client, fillEvent(1));

    await expect(client.closed).resolves.toMatchObject({ code: 4000 });
    expect(ingestFills).not.toHaveBeenCalled();
  });

  it('closes the older session with 4001 when the cluster says hello again', async () => {
    const older = await connect(TOKEN_ONE);
    send(older, hello(1));
    await vi.waitFor(() =>
      expect(assignment.requestAssignment).toHaveBeenCalledTimes(1),
    );

    const newer = await connect(TOKEN_ONE);
    send(newer, hello(1));

    await expect(older.closed).resolves.toEqual({
      code: 4001,
      reason: 'replaced',
    });
    await vi.waitFor(() =>
      expect(assignment.requestAssignment).toHaveBeenCalledTimes(2),
    );
    expect(newer.socket.readyState).toBe(WebSocket.OPEN);
    expect(assignment.requestAssignmentAfterGrace).not.toHaveBeenCalled();
  });

  it('answers each heartbeat with the sent time and the server time', async () => {
    const client = await connect(TOKEN_ONE);
    send(client, hello(1));

    send(client, {
      type: 'heartbeat',
      sentAt: 1_770_000_000_000,
      stats: {
        upstreamState: 'open',
        upstreamConnectedAt: 1_769_999_000_000,
        upstreamReconnects: 0,
        pingRoundTripMs: 120,
        clockOffsetMs: 3,
        eventLoopDelayP99Ms: 12,
        rssBytes: 80_000_000,
        weightUsedLastMinute: 40,
        wallets: [],
      },
    });

    await vi.waitFor(() => expect(client.frames).toHaveLength(1));
    expect(client.frames[0]).toMatchObject({
      type: 'heartbeatAck',
      sentAt: 1_770_000_000_000,
    });
    expect(client.frames[0].serverTime).toEqual(expect.any(Number));
  });

  it('hands frames to ingestion one at a time in the order they arrived', async () => {
    const calls: string[] = [];
    ingestFills.mockImplementation(
      async (_key: number, _cluster: number, event: UserFillsEvent) => {
        const tid = readTid(event);
        calls.push(`start ${tid}`);
        await sleep(tid % 2 === 0 ? 30 : 5);
        calls.push(`end ${tid}`);
      },
    );
    const client = await connect(TOKEN_ONE);
    send(client, hello(1));

    for (let tid = 1; tid <= 6; tid += 1) {
      send(client, fillEvent(tid));
    }

    await vi.waitFor(() => expect(calls).toHaveLength(12), { timeout: 2_000 });
    expect(calls).toEqual(
      [1, 2, 3, 4, 5, 6].flatMap((tid) => [`start ${tid}`, `end ${tid}`]),
    );
    expect(ingestFills.mock.calls[0][1]).toBe(1);
  });

  it('drops a frame that fails to parse and keeps the session', async () => {
    const client = await connect(TOKEN_ONE);
    send(client, hello(1));

    client.socket.send('not json');
    send(client, { ...fillEvent(1), wallet: '0xnot-an-address' });
    send(client, fillEvent(2));

    await vi.waitFor(() => expect(ingestFills).toHaveBeenCalledTimes(1));
    expect(readTid(ingestFills.mock.calls[0][2])).toBe(2);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('drops a frame that fails for a data reason and processes the next one', async () => {
    ingestFills.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Foreign key violated', {
        code: 'P2003',
        clientVersion: '7.8.0',
      }),
    );
    const client = await connect(TOKEN_ONE);
    send(client, hello(1));

    send(client, fillEvent(1));
    send(client, fillEvent(2));

    await vi.waitFor(() => expect(ingestFills).toHaveBeenCalledTimes(2));
    await sleep(20);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('closes with 4005 after a storage failure and processes no later frame', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    ingestFills.mockImplementationOnce(async () => {
      await blocked;
      throw new Prisma.PrismaClientKnownRequestError(
        "Can't reach database server",
        { code: 'P1001', clientVersion: '7.8.0' },
      );
    });
    const client = await connect(TOKEN_ONE);
    send(client, hello(1));
    send(client, fillEvent(1));
    send(client, fillEvent(2));
    send(client, fillEvent(3));
    await vi.waitFor(() => expect(ingestFills).toHaveBeenCalledTimes(1));

    release();

    await expect(client.closed).resolves.toEqual({
      code: 4005,
      reason: 'storage_unavailable',
    });
    expect(ingestFills).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(assignment.requestAssignmentAfterGrace).toHaveBeenCalledTimes(1),
    );
  });
});
