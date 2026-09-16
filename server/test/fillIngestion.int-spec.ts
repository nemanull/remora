import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type {
  AssignMessage,
  HyperliquidFill,
  HyperliquidUserFillsFrame,
} from '@remora/sdk';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client as PostgresClient } from 'pg';
import { EMPTY } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ClustersModule } from '../src/clusters/clusters.module';
import { validateServerConfig } from '../src/config';
import { CopyDecisionService } from '../src/copy/copyDecision.service';
import { CopyEventsModule } from '../src/copy/copyEvents.module';
import type { Signal } from '../src/copy/types';
import { MarketDataService } from '../src/market/marketData.service';
import { MetricsModule } from '../src/metrics/metrics.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { startMigratedPostgres } from './migratedPostgres';

const SNAPSHOT = JSON.parse(
  readFileSync(
    join(__dirname, '../../payloads/userFills/snapshot.json'),
    'utf8',
  ),
) as HyperliquidUserFillsFrame;
const WALLET = SNAPSHOT.data.user;
const TRACKED_SINCE = new Date('2026-01-01T00:00:00.000Z');
const LAST_SNAPSHOT_TIME = Math.max(
  ...SNAPSHOT.data.fills.map((fill) => fill.time),
);
const LARGEST_SAFE_TID = Number.MAX_SAFE_INTEGER;
const TOKEN = randomBytes(32).toString('hex');
const INGEST_ROLE = 'ingest';

type Link = {
  socket: WebSocket;
  frames: Record<string, unknown>[];
  closeCode: number | null;
  closed: Promise<number>;
};

const MAX_RESUME_ATTEMPTS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamFill(
  tid: number,
  time: number,
  overrides: Partial<HyperliquidFill> = {},
): HyperliquidFill {
  return {
    coin: 'HYPE',
    px: '31.9',
    sz: '0.5',
    side: 'B',
    time,
    startPosition: '0.0',
    dir: 'Open Long',
    closedPnl: '0.0',
    hash: '0x00',
    oid: tid,
    crossed: true,
    fee: '0.007',
    tid,
    feeToken: 'USDC',
    twapId: null,
    ...overrides,
  };
}

function userFillsEvent(
  source: 'stream' | 'snapshot' | 'backfill',
  fills: HyperliquidFill[],
) {
  const receivedAt = Math.max(...fills.map((fill) => fill.time)) + 270;
  return {
    type: 'event',
    wallet: WALLET,
    channel: 'userFills',
    source,
    receivedAt,
    payload:
      source === 'backfill'
        ? fills
        : {
            ...(source === 'snapshot' ? { isSnapshot: true } : {}),
            user: WALLET,
            fills,
          },
  };
}

describe('fill ingestion over the cluster link', () => {
  let container: StartedPostgreSqlContainer;
  let admin: PostgresClient;
  let app: INestApplication;
  let prisma: PrismaService;
  let url: string;
  const routed: Signal[][] = [];
  const links: Link[] = [];

  beforeAll(async () => {
    container = await startMigratedPostgres();
    admin = new PostgresClient({
      connectionString: container.getConnectionUri(),
    });
    await admin.connect();
    await admin.query(
      `CREATE ROLE ${INGEST_ROLE} LOGIN PASSWORD '${INGEST_ROLE}'`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${INGEST_ROLE}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${INGEST_ROLE}`,
    );
    await admin.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${INGEST_ROLE}`,
    );
    const ingestUrl = `postgresql://${INGEST_ROLE}:${INGEST_ROLE}@${container.getHost()}:${container.getPort()}/remora`;
    const config = validateServerConfig({
      DATABASE_URL: ingestUrl,
      REDIS_URL: 'redis://127.0.0.1:9',
      HYPERLIQUID_API_URL: 'http://127.0.0.1:9',
      HYPERLIQUID_WS_URL: 'ws://127.0.0.1:9/ws',
      CLUSTER_TOKEN_HASHES: `1:${createHash('sha256').update(TOKEN).digest('hex')}`,
    });
    const markets = new Map(
      ['BTC', 'HYPE', 'PUMP', 'SOL', 'XRP'].map((coin) => [coin, {}]),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          skipProcessEnv: true,
          load: [() => config],
        }),
        PrismaModule,
        MetricsModule,
        CopyEventsModule,
        ClustersModule,
      ],
    })
      .overrideProvider(MarketDataService)
      .useValue({
        hasMarkets: () => true,
        readMarkets: () => markets,
        mids$: EMPTY,
      })
      .overrideProvider(CopyDecisionService)
      .useValue({ routeSignals: (signals: Signal[]) => routed.push(signals) })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService);
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    url = `ws://127.0.0.1:${port}/cluster`;
    await prisma.wallet.create({
      data: {
        address: WALLET,
        status: 'SHADOW',
        source: 'MANUAL',
        trackedSince: TRACKED_SINCE,
      },
    });
  });

  afterAll(async () => {
    for (const link of links) {
      link.socket.terminate();
    }
    await app?.close();
    await admin?.end();
    await container?.stop();
  });

  function connect(): Promise<Link> {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
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
    const link: Link = {
      socket,
      frames,
      closeCode: null,
      closed: new Promise<number>((resolve) =>
        socket.on('close', (code) => {
          link.closeCode = code;
          resolve(code);
        }),
      ),
    };
    links.push(link);
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(link));
      socket.once('error', reject);
    });
  }

  function send(link: Link, frame: unknown): void {
    link.socket.send(JSON.stringify(frame));
  }

  async function waitUntil(
    link: Link,
    isDone: () => boolean,
  ): Promise<boolean> {
    for (let waited = 0; waited < 5_000; waited += 20) {
      if (isDone()) {
        return true;
      }
      if (link.closeCode !== null) {
        return false;
      }
      await sleep(20);
    }
    throw new Error('Timed out waiting for the core');
  }

  async function tryOpenSession(): Promise<{
    link: Link;
    assign: AssignMessage | null;
  }> {
    const link = await connect();
    send(link, {
      type: 'hello',
      protocolVersion: 1,
      clusterId: 1,
      sessionId: randomUUID(),
      maxWallets: 8,
      version: '0.0.1',
    });
    const readAssign = () =>
      link.frames.find((frame) => frame.type === 'assign') as
        | AssignMessage
        | undefined;
    if (!(await waitUntil(link, () => readAssign() !== undefined))) {
      return { link, assign: null };
    }
    const assign = readAssign() as AssignMessage;
    send(link, {
      type: 'assigned',
      version: assign.version,
      subscribed: assign.wallets.map((wallet) => wallet.address),
      failed: [],
    });
    return { link, assign };
  }

  async function openSession(): Promise<{ link: Link; assign: AssignMessage }> {
    const { link, assign } = await tryOpenSession();
    if (assign === null) {
      throw new Error(`The core closed the session with ${link.closeCode}`);
    }
    return { link, assign };
  }

  function countFills(): Promise<number> {
    return prisma.leaderFill.count({ where: { walletAddress: WALLET } });
  }

  async function readWatermark(): Promise<Date | null> {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { address: WALLET },
    });
    return wallet.fillsSyncedUntil;
  }

  async function waitForFillCount(count: number): Promise<void> {
    await vi.waitFor(async () => expect(await countFills()).toBe(count), {
      timeout: 5_000,
    });
  }

  async function waitForRouted(count: number): Promise<void> {
    await vi.waitFor(() => expect(routed).toHaveLength(count), {
      timeout: 5_000,
    });
  }

  let session: Link;

  it('assigns the tracked wallet from its tracked_since when a collector says hello', async () => {
    const { link, assign } = await openSession();
    session = link;

    expect(assign.wallets).toEqual([
      { address: WALLET, fillsSince: TRACKED_SINCE.getTime() },
    ]);
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { address: WALLET },
    });
    expect(wallet.clusterId).toBe(1);
  });

  it('stores a repeated batch once and holds its signals until synced', async () => {
    const liveFill = streamFill(LARGEST_SAFE_TID, LAST_SNAPSHOT_TIME + 60_000);

    send(session, userFillsEvent('snapshot', SNAPSHOT.data.fills));
    send(session, userFillsEvent('backfill', SNAPSHOT.data.fills));
    send(session, userFillsEvent('stream', [liveFill]));
    await waitForFillCount(SNAPSHOT.data.fills.length + 1);

    expect(routed).toEqual([]);
    await expect(readWatermark()).resolves.toBeNull();

    send(session, { type: 'synced', wallet: WALLET });
    await waitForRouted(1);

    await expect(readWatermark()).resolves.toEqual(new Date(liveFill.time));
    expect(routed[0].map((signal) => signal.coin)).toEqual([
      'PUMP',
      'HYPE',
      'SOL',
      'XRP',
    ]);
    expect(routed[0].every((signal) => signal.source === 'catch_up')).toBe(
      true,
    );
    const hype = routed[0][1];
    expect(hype.positionAfter.toString()).toBe('0.5');
    expect(hype.episodeOpenTid).toBe(BigInt(LARGEST_SAFE_TID));
  });

  it('keeps tid as a bigint all the way from the frame to the row', async () => {
    const row = await prisma.leaderFill.findFirstOrThrow({
      where: { walletAddress: WALLET, tid: BigInt(LARGEST_SAFE_TID) },
    });

    expect(row.tid).toBe(9_007_199_254_740_991n);
    expect(row.source).toBe('STREAM');
    expect(row.clusterId).toBe(1);
    const snapshotRow = await prisma.leaderFill.findFirstOrThrow({
      where: { walletAddress: WALLET, tid: 1_111_063_246_686_638n },
    });
    expect(snapshotRow.source).toBe('SNAPSHOT');
    expect(snapshotRow.px.toString()).toBe('1.4217');
  });

  it('raises the watermark with every live frame and signals only new rows', async () => {
    const repeated = streamFill(LARGEST_SAFE_TID, LAST_SNAPSHOT_TIME + 60_000);
    const added = streamFill(5_000_001, LAST_SNAPSHOT_TIME + 61_000, {
      startPosition: '0.5',
      dir: 'Open Long',
    });

    send(session, userFillsEvent('stream', [repeated, added]));
    await waitForRouted(2);

    expect(routed[1]).toHaveLength(1);
    const [signal] = routed[1];
    expect(signal.source).toBe('stream');
    expect(signal.firstTid).toBe(5_000_001n);
    expect(signal.positionBefore.toString()).toBe('0.5');
    expect(signal.positionAfter.toString()).toBe('1');
    await expect(readWatermark()).resolves.toEqual(new Date(added.time));
  });

  it('never moves the watermark past a fill stored while the wallet is unsynced', async () => {
    const watermark = await readWatermark();
    const fillCount = await countFills();
    const streamed = streamFill(5_000_002, LAST_SNAPSHOT_TIME + 90_000, {
      startPosition: '1.0',
    });
    const backfilled = streamFill(5_000_003, LAST_SNAPSHOT_TIME + 70_000, {
      coin: 'BTC',
      px: '80000',
      sz: '0.001',
    });

    send(session, { type: 'syncStarted', wallets: [WALLET] });
    send(session, userFillsEvent('stream', [streamed]));
    send(session, userFillsEvent('backfill', [backfilled]));
    await waitForFillCount(fillCount + 2);

    await expect(readWatermark()).resolves.toEqual(watermark);
    expect(routed).toHaveLength(2);

    send(session, { type: 'synced', wallet: WALLET });
    await waitForRouted(3);

    await expect(readWatermark()).resolves.toEqual(new Date(streamed.time));
    expect(routed[2].map((signal) => signal.coin)).toContain('BTC');
  });

  it('drops a frame that fails for a data reason and keeps the session', async () => {
    const fillCount = await countFills();
    const broken = streamFill(5_000_004, LAST_SNAPSHOT_TIME + 200_000, {
      px: '1e40',
    });
    const valid = streamFill(5_000_005, LAST_SNAPSHOT_TIME + 100_000, {
      startPosition: '1.5',
    });

    send(session, userFillsEvent('stream', [broken]));
    send(session, userFillsEvent('stream', [valid]));
    await waitForFillCount(fillCount + 1);

    await expect(readWatermark()).resolves.toEqual(new Date(valid.time));
    expect(session.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('closes the session with 4005 in a database outage and resumes from the watermark', async () => {
    const watermark = await readWatermark();
    const fillCount = await countFills();
    const lost = streamFill(5_000_006, LAST_SNAPSHOT_TIME + 300_000, {
      startPosition: '2.0',
    });
    const later = streamFill(5_000_007, LAST_SNAPSHOT_TIME + 301_000, {
      startPosition: '2.5',
    });

    await admin.query(`ALTER ROLE ${INGEST_ROLE} NOLOGIN`);
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${INGEST_ROLE}'`,
    );
    send(session, userFillsEvent('stream', [lost]));
    send(session, userFillsEvent('stream', [later]));

    await expect(session.closed).resolves.toBe(4005);
    await admin.query(`ALTER ROLE ${INGEST_ROLE} LOGIN`);
    await expect(countFills()).resolves.toBe(fillCount);
    await expect(readWatermark()).resolves.toEqual(watermark);

    const routedBefore = routed.length;
    const assigns: AssignMessage[] = [];
    let attempts = 0;
    let isSynced = false;
    while (!isSynced && attempts < MAX_RESUME_ATTEMPTS) {
      attempts += 1;
      const { link, assign } = await tryOpenSession();
      if (assign === null) {
        continue;
      }
      assigns.push(assign);
      send(link, userFillsEvent('backfill', [lost, later]));
      send(link, { type: 'synced', wallet: WALLET });
      isSynced = await waitUntil(link, () => routed.length > routedBefore);
    }

    expect(isSynced).toBe(true);
    for (const assign of assigns) {
      expect(assign.wallets).toEqual([
        { address: WALLET, fillsSince: watermark?.getTime() },
      ]);
    }
    await expect(countFills()).resolves.toBe(fillCount + 2);
    await expect(readWatermark()).resolves.toEqual(new Date(later.time));
    expect(routed.at(-1)?.every((signal) => signal.source === 'catch_up')).toBe(
      true,
    );
  });
});
