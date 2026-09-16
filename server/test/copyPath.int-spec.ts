import type { HyperliquidFill } from '@remora/sdk';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Decimal } from 'decimal.js';
import { createHash, randomBytes } from 'node:crypto';
import { Subject } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateServerConfig } from '../src/config';
import { CopyDecisionService } from '../src/copy/copyDecision.service';
import { CopyEventsModule } from '../src/copy/copyEvents.module';
import { PaperBookReader } from '../src/execution/paperBookReader';
import { SignalBuilder } from '../src/copy/signalBuilder';
import {
  FillIngestionService,
  type UserFillsEvent,
} from '../src/ingestion/fillIngestion.service';
import { IngestionModule } from '../src/ingestion/ingestion.module';
import { SyncStateService } from '../src/ingestion/syncState.service';
import {
  type Market,
  MarketDataService,
  type MidsUpdate,
  type OrderBook,
} from '../src/market/marketData.service';
import { MetricsModule } from '../src/metrics/metrics.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { startMigratedPostgres } from './migratedPostgres';

const WALLET = '0x9e6b92cd44167d06b102e683df3f02e23d932e4f';
const SESSION = 1;
const CLUSTER = 1;
const TOKEN = randomBytes(32).toString('hex');
const MID = new Decimal(3_000);

const ETH: Market = {
  coin: 'ETH',
  assetIndex: 1,
  szDecimals: 4,
  maxLeverage: 25,
  isOnlyIsolated: false,
  marginMode: null,
  fundingRate: new Decimal('0.0000125'),
  markPrice: MID,
  oraclePrice: MID,
};

const MARKETS = new Map([['ETH', ETH]]);

function level(price: number, size: number) {
  return { price: new Decimal(price), size: new Decimal(size) };
}

const marketData = {
  hasMarkets: () => true,
  readMarkets: () => MARKETS,
  readMarket: (coin: string) => MARKETS.get(coin) ?? null,
  readMarketsRefreshedAt: () => new Date(),
  readMid: (coin: string) =>
    MARKETS.has(coin) ? { price: MID, receivedAt: new Date() } : null,
  refreshMarkets: () => Promise.resolve(1),
  mids$: new Subject<MidsUpdate>().asObservable(),
};

const paperBooks = {
  readBook: (coin: string): Promise<OrderBook> =>
    Promise.resolve({
      coin,
      time: new Date(),
      bids: [level(2_999, 5), level(2_998, 50)],
      asks: [level(3_001, 5), level(3_002, 50)],
    }),
};

let nextTid = 1_000;

function leaderFill(
  side: 'B' | 'A',
  size: string,
  startPosition: string,
  ageMs = 200,
): HyperliquidFill {
  nextTid += 1;
  return {
    coin: 'ETH',
    px: '3000',
    sz: size,
    side,
    time: Date.now() - ageMs,
    startPosition,
    dir: side === 'B' ? 'Open Long' : 'Close Long',
    closedPnl: '0',
    hash: `0x${nextTid.toString(16).padStart(64, '0')}`,
    oid: nextTid,
    crossed: true,
    fee: '1.35',
    tid: nextTid,
    feeToken: 'USDC',
    twapId: null,
  };
}

function userFills(
  source: 'stream' | 'snapshot' | 'backfill',
  fills: HyperliquidFill[],
): UserFillsEvent {
  const receivedAt = Math.max(...fills.map((fill) => fill.time)) + 270;
  if (source === 'backfill') {
    return {
      type: 'event',
      wallet: WALLET,
      channel: 'userFills',
      source,
      receivedAt,
      payload: fills,
    };
  }
  return {
    type: 'event',
    wallet: WALLET,
    channel: 'userFills',
    source,
    receivedAt,
    payload:
      source === 'snapshot'
        ? { isSnapshot: true, user: WALLET, fills }
        : { user: WALLET, fills },
  };
}

describe('copy path from a leader fill to a paper copy', () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let core: TestingModule;
  let prisma: PrismaService;
  const trackedSince = new Date(Date.now() - 3_600_000);

  async function startCore(paperLatencyMs = 0): Promise<void> {
    const config = validateServerConfig({
      DATABASE_URL: databaseUrl,
      REDIS_URL: 'redis://127.0.0.1:9',
      HYPERLIQUID_API_URL: 'http://127.0.0.1:9',
      HYPERLIQUID_WS_URL: 'ws://127.0.0.1:9/ws',
      CLUSTER_TOKEN_HASHES: `1:${createHash('sha256').update(TOKEN).digest('hex')}`,
      PAPER_ORDER_LATENCY_MS: String(paperLatencyMs),
    });
    core = await Test.createTestingModule({
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
        IngestionModule,
      ],
    })
      .overrideProvider(MarketDataService)
      .useValue(marketData)
      .overrideProvider(PaperBookReader)
      .useValue(paperBooks)
      .compile();
    core.useLogger(false);
    await core.init();
    prisma = core.get(PrismaService);
  }

  async function syncWallet(version: number): Promise<void> {
    const syncState = core.get(SyncStateService);
    syncState.markAssigned(SESSION, version, [
      { address: WALLET, trackedSince },
    ]);
    syncState.markAssignApplied(SESSION, version);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);
    await core.get(CopyDecisionService).waitUntilIdle();
  }

  async function ingest(event: UserFillsEvent): Promise<void> {
    await core.get(FillIngestionService).ingestFills(SESSION, CLUSTER, event);
    await core.get(CopyDecisionService).waitUntilIdle();
  }

  function readShadowCopies() {
    return prisma.copyPosition.findMany({
      where: { walletAddress: WALLET, book: 'SHADOW' },
      orderBy: { id: 'asc' },
    });
  }

  beforeAll(async () => {
    Logger.overrideLogger(false);
    container = await startMigratedPostgres();
    databaseUrl = container.getConnectionUri();
    await startCore();
    await prisma.wallet.create({
      data: {
        address: WALLET,
        status: 'SHADOW',
        source: 'MANUAL',
        trackedSince,
      },
    });
    await prisma.leaderState.create({
      data: {
        walletAddress: WALLET,
        equityUsd: '100000',
        equityAt: new Date(),
      },
    });
    await syncWallet(1);
  });

  afterAll(async () => {
    await core?.close();
    await container?.stop();
  });

  it('opens a paper copy from a stream fill with a stored decision and trace', async () => {
    const open = leaderFill('B', '10', '0');
    await ingest(userFills('stream', [open]));

    const decisions = await prisma.copyDecision.findMany();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      book: 'SHADOW',
      signalKey: `${WALLET}-ETH-${open.tid}`,
      signalSource: 'stream',
      action: 'OPEN',
      verdict: 'COPY',
      reason: 'copied',
    });
    expect(decisions[0].trace).toHaveLength(11);
    const [order] = await prisma.order.findMany();
    expect(order).toMatchObject({
      book: 'SHADOW',
      purpose: 'ENTRY',
      status: 'FILLED',
      decisionId: decisions[0].id,
    });
    expect(order.avgPx?.toString()).toBe('3001');
    expect(order.slippageBps).toBeCloseTo(3.333, 2);
    const [copy] = await readShadowCopies();
    expect(copy.size.toString()).toBe('0.5');
    expect(copy.ratio.toString()).toBe('0.05');
    expect(copy.leaderOpenTid).toBe(BigInt(open.tid));
    expect(copy.stopPx).not.toBeNull();
    const fill = await prisma.leaderFill.findFirstOrThrow({
      where: { tid: BigInt(open.tid) },
    });
    expect(fill.signalledAt).not.toBeNull();
  });

  it('resizes the copy as the leader adds and trims', async () => {
    await ingest(userFills('stream', [leaderFill('B', '5', '10')]));
    expect((await readShadowCopies())[0].size.toString()).toBe('0.75');

    await ingest(userFills('stream', [leaderFill('A', '9', '15')]));
    const [copy] = await readShadowCopies();
    expect(copy.size.toString()).toBe('0.3');
    expect(copy.leaderSizeAtSync.toString()).toBe('6');
    expect(new Decimal(copy.realizedPnl.toString()).toFixed(2)).toBe('-0.90');
  });

  it('closes the copy when the leader goes flat', async () => {
    await ingest(userFills('stream', [leaderFill('A', '6', '6')]));
    const [copy] = await readShadowCopies();
    expect(copy).toMatchObject({ isOpen: false, closeReason: 'leader_closed' });
    expect(copy.size.toString()).toBe('0');
    const actions = await prisma.copyDecision.findMany({
      orderBy: { id: 'asc' },
      select: { action: true },
    });
    expect(actions.map((decision) => decision.action)).toEqual([
      'OPEN',
      'INCREASE',
      'REDUCE',
      'CLOSE',
    ]);
  });

  it('decides the same fills once when the core died before signalled_at', async () => {
    const open = leaderFill('B', '4', '0');
    await ingest(userFills('stream', [open]));
    const decisionsBefore = await prisma.copyDecision.count();
    const ordersBefore = await prisma.order.count();
    await prisma.leaderFill.updateMany({
      where: { tid: BigInt(open.tid) },
      data: { signalledAt: null },
    });
    await core.close();

    await startCore();
    await syncWallet(1);

    expect(await prisma.copyDecision.count()).toBe(decisionsBefore);
    expect(await prisma.order.count()).toBe(ordersBefore);
    const fill = await prisma.leaderFill.findFirstOrThrow({
      where: { tid: BigInt(open.tid) },
    });
    expect(fill.signalledAt).not.toBeNull();
    const copies = await readShadowCopies();
    expect(copies.filter((copy) => copy.isOpen)).toHaveLength(1);
    expect(copies.at(-1)?.size.toString()).toBe('0.2');
  });

  it('decides only the fills that arrived after a decided signal when the catch-up extends it', async () => {
    const add = leaderFill('B', '2', '4');
    await ingest(userFills('stream', [add]));
    await prisma.leaderFill.updateMany({
      where: { tid: BigInt(add.tid) },
      data: { signalledAt: null },
    });
    await core.close();

    await startCore();
    const missed = leaderFill('B', '2', '6');
    await core
      .get(FillIngestionService)
      .ingestFills(SESSION, CLUSTER, userFills('backfill', [add, missed]));
    await syncWallet(1);

    const increases = await prisma.copyDecision.findMany({
      where: {
        signalKey: {
          in: [`${WALLET}-ETH-${add.tid}`, `${WALLET}-ETH-${missed.tid}`],
        },
      },
      orderBy: { id: 'asc' },
    });
    expect(increases.map((decision) => decision.signalKey)).toEqual([
      `${WALLET}-ETH-${add.tid}`,
      `${WALLET}-ETH-${missed.tid}`,
    ]);
    expect(increases[1].signalSource).toBe('catch_up');
    const open = (await readShadowCopies()).filter((copy) => copy.isOpen);
    expect(open.map((copy) => copy.size.toString())).toEqual(['0.4']);
    const unsignalled = await prisma.leaderFill.count({
      where: { walletAddress: WALLET, signalledAt: null },
    });
    expect(unsignalled).toBe(0);
  });

  it('never copies a fill twice when a catch-up overlaps a signal still in flight', async () => {
    await core.close();
    await startCore(300);
    await syncWallet(1);
    const add = leaderFill('B', '2', '8');
    await core
      .get(FillIngestionService)
      .ingestFills(SESSION, CLUSTER, userFills('stream', [add]));
    const catchUp = await core
      .get(SignalBuilder)
      .buildCatchUp(WALLET, trackedSince);
    expect(catchUp.map((signal) => signal.fillIds.length)).toEqual([1]);
    core.get(CopyDecisionService).routeSignals(catchUp);
    await core.get(CopyDecisionService).waitUntilIdle();

    const decisions = await prisma.copyDecision.count({
      where: { signalKey: `${WALLET}-ETH-${add.tid}` },
    });
    expect(decisions).toBe(1);
    const open = (await readShadowCopies()).filter((copy) => copy.isOpen);
    expect(open.map((copy) => copy.size.toString())).toEqual(['0.5']);
  });

  it('records an older signal as out of order without trading', async () => {
    const stale = leaderFill('A', '1', '10', 120_000);
    await ingest(userFills('stream', [stale]));
    const decision = await prisma.copyDecision.findFirstOrThrow({
      where: { signalKey: `${WALLET}-ETH-${stale.tid}` },
    });
    expect(decision).toMatchObject({ verdict: 'SKIP', reason: 'out_of_order' });
    const open = (await readShadowCopies()).filter((copy) => copy.isOpen);
    expect(open.map((copy) => copy.size.toString())).toEqual(['0.5']);
  });
});
