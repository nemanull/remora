import { Logger } from '@nestjs/common';
import type { HyperliquidFill } from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopyDecisionService } from '../copy/copyDecision.service';
import { SignalBuilder, type StoredFill } from '../copy/signalBuilder';
import type { Signal } from '../copy/types';
import type { MarketDataService } from '../market/marketData.service';
import { MetricsService } from '../metrics/metrics.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  FillIngestionService,
  type UserFillsEvent,
} from './fillIngestion.service';
import { SyncStateService } from './syncState.service';

const WALLET = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';
const OTHER_WALLET = '0x654086857e1fad6dcf05cf6695cce51ea3984268';
const SESSION = 7;
const CLUSTER = 1;
const TRACKED_SINCE = new Date('2026-03-01T00:00:00.000Z');
const START = Date.parse('2026-03-02T10:00:00.000Z');

type StoredRow = StoredFill & { walletAddress: string; signalledAt: null };

function createFakePrisma() {
  const rows: StoredRow[] = [];
  const watermarks: Date[] = [];
  let nextId = 1n;
  const prisma = {
    leaderFill: {
      createManyAndReturn: vi.fn(
        ({
          data,
        }: {
          data: {
            walletAddress: string;
            coin: string;
            tid: bigint;
            px: string;
            sz: string;
            side: string;
            time: Date;
            startPosition: string;
            receivedAt: Date;
          }[];
        }) => {
          const inserted: StoredRow[] = [];
          for (const fill of data) {
            const isDuplicate = rows.some(
              (row) => row.coin === fill.coin && row.tid === fill.tid,
            );
            if (isDuplicate) {
              continue;
            }
            const row = {
              id: nextId,
              walletAddress: fill.walletAddress,
              coin: fill.coin,
              tid: fill.tid,
              px: new Decimal(fill.px),
              sz: new Decimal(fill.sz),
              side: fill.side,
              time: fill.time,
              startPosition: new Decimal(fill.startPosition),
              receivedAt: fill.receivedAt,
              signalledAt: null,
            } as unknown as StoredRow;
            nextId += 1n;
            rows.push(row);
            inserted.push(row);
          }
          return Promise.resolve(inserted.reverse());
        },
      ),
      findMany: vi.fn(({ where }: { where: { time: { gte: Date } } }) =>
        Promise.resolve(
          rows
            .filter((row) => row.time >= where.time.gte)
            .sort(
              (first, second) =>
                first.time.getTime() - second.time.getTime() ||
                Number(first.id - second.id),
            ),
        ),
      ),
    },
    wallet: {
      updateMany: vi.fn(({ data }: { data: { fillsSyncedUntil: Date } }) => {
        watermarks.push(data.fillsSyncedUntil);
        return Promise.resolve({ count: 1 });
      }),
    },
  };
  return { prisma, rows, watermarks };
}

let nextTid = 1;

function hyperliquidFill(
  coin: string,
  side: 'A' | 'B',
  size: string,
  startPosition: string,
  offsetMs: number,
): HyperliquidFill {
  nextTid += 1;
  return {
    coin,
    px: '100',
    sz: size,
    side,
    time: START + offsetMs,
    startPosition,
    dir: side === 'B' ? 'Open Long' : 'Close Long',
    closedPnl: '0',
    hash: '0x00',
    oid: nextTid,
    crossed: true,
    fee: '0.01',
    tid: nextTid,
    feeToken: 'USDC',
    twapId: null,
  };
}

function streamEvent(
  fills: HyperliquidFill[],
  wallet = WALLET,
): UserFillsEvent {
  return {
    type: 'event',
    wallet,
    channel: 'userFills',
    source: 'stream',
    receivedAt: Math.max(...fills.map((fill) => fill.time)) + 250,
    payload: { user: wallet, fills },
  };
}

function backfillEvent(fills: HyperliquidFill[]): UserFillsEvent {
  return {
    type: 'event',
    wallet: WALLET,
    channel: 'userFills',
    source: 'backfill',
    receivedAt: START + 60_000,
    payload: fills,
  };
}

describe('SyncStateService', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  let fake: ReturnType<typeof createFakePrisma>;
  let routed: Signal[][];
  let syncState: SyncStateService;
  let ingestion: FillIngestionService;
  let metrics: MetricsService;

  beforeEach(() => {
    fake = createFakePrisma();
    routed = [];
    const prisma = fake.prisma as unknown as PrismaService;
    const copyDecision = {
      routeSignals: (signals: Signal[]) => routed.push(signals),
    } as unknown as CopyDecisionService;
    const marketData = {
      readMarkets: () =>
        new Map([
          ['BTC', {}],
          ['HYPE', {}],
        ]),
    } as unknown as MarketDataService;
    const signalBuilder = new SignalBuilder(prisma);
    metrics = new MetricsService();
    syncState = new SyncStateService(prisma, signalBuilder, copyDecision);
    ingestion = new FillIngestionService(
      prisma,
      marketData,
      syncState,
      signalBuilder,
      copyDecision,
      metrics,
    );
  });

  function assign(version: number, isApplied = true) {
    syncState.markAssigned(SESSION, version, [
      { address: WALLET, trackedSince: TRACKED_SINCE },
    ]);
    if (isApplied) {
      syncState.markAssignApplied(SESSION, version);
    }
  }

  it('holds the signals of a wallet listed for the first time and keeps its watermark', async () => {
    assign(1);

    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'B', '1', '0', 0)]),
    );

    expect(fake.rows).toHaveLength(1);
    expect(routed).toEqual([]);
    expect(fake.watermarks).toEqual([]);
    expect(syncState.readWallet(SESSION, WALLET)?.isSynced).toBe(false);
  });

  it('releases held fills as one catch-up per coin and raises the watermark to the latest fill received on synced', async () => {
    assign(1);
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      backfillEvent([
        hyperliquidFill('BTC', 'B', '1', '0', 0),
        hyperliquidFill('HYPE', 'A', '5', '0', 1_000),
      ]),
    );
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'B', '1', '1', 5_000)]),
    );

    await syncState.completeSync(SESSION, CLUSTER, WALLET);

    expect(fake.watermarks).toEqual([new Date(START + 5_000)]);
    expect(routed).toHaveLength(1);
    const [btc, hype] = routed[0];
    expect(btc.source).toBe('catch_up');
    expect(btc.coin).toBe('BTC');
    expect(btc.fillIds).toEqual([1n, 3n]);
    expect(btc.positionAfter.toString()).toBe('2');
    expect(hype.coin).toBe('HYPE');
    expect(syncState.readWallet(SESSION, WALLET)?.isSynced).toBe(true);
  });

  it('raises the watermark on every processed stream frame while the wallet is synced', async () => {
    assign(1);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);

    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([
        hyperliquidFill('BTC', 'B', '1', '0', 0),
        hyperliquidFill('BTC', 'B', '1', '1', 0),
      ]),
    );
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'A', '2', '2', 2_000)]),
    );

    expect(fake.watermarks).toEqual([new Date(START), new Date(START + 2_000)]);
    expect(routed.map((signals) => signals[0].source)).toEqual([
      'stream',
      'stream',
    ]);
    expect(routed[1][0].touchedZero).toBe(true);
  });

  it('builds live signals only from fills the insert returned', async () => {
    assign(1);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);
    const first = hyperliquidFill('BTC', 'B', '1', '0', 0);
    const second = hyperliquidFill('BTC', 'B', '1', '1', 10);

    await ingestion.ingestFills(SESSION, CLUSTER, streamEvent([first]));
    await ingestion.ingestFills(SESSION, CLUSTER, streamEvent([first, second]));

    expect(routed).toHaveLength(2);
    expect(routed[1][0].fillIds).toEqual([2n]);
    expect(routed[1][0].positionBefore.toString()).toBe('1');
  });

  it('holds signals again after syncStarted until the next synced', async () => {
    assign(1);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'B', '1', '0', 0)]),
    );

    syncState.markSyncStarted(SESSION, [WALLET]);
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'B', '1', '1', 9_000)]),
    );
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      backfillEvent([hyperliquidFill('BTC', 'B', '1', '2', 4_000)]),
    );

    expect(fake.watermarks).toEqual([new Date(START)]);
    expect(routed).toHaveLength(1);

    await syncState.completeSync(SESSION, CLUSTER, WALLET);

    expect(fake.watermarks).toEqual([new Date(START), new Date(START + 9_000)]);
    expect(routed[1][0].source).toBe('catch_up');
  });

  it('ignores a synced that arrives before assigned of the version that added the wallet', async () => {
    assign(3, false);
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'B', '1', '0', 0)]),
    );

    await syncState.completeSync(SESSION, CLUSTER, WALLET);

    expect(fake.watermarks).toEqual([]);
    expect(routed).toEqual([]);
    expect(syncState.readWallet(SESSION, WALLET)?.isSynced).toBe(false);

    syncState.markAssignApplied(SESSION, 3);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);

    expect(fake.watermarks).toEqual([new Date(START)]);
    expect(syncState.readWallet(SESSION, WALLET)?.isSynced).toBe(true);
  });

  it('moves the watermark past fills outside the main dex without storing them', async () => {
    assign(1);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);

    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([
        hyperliquidFill('xyz:MU', 'B', '1', '0', 3_000),
        hyperliquidFill('@107', 'B', '1', '0', 3_500),
      ]),
    );

    expect(fake.prisma.leaderFill.createManyAndReturn).not.toHaveBeenCalled();
    expect(fake.watermarks).toEqual([new Date(START + 3_500)]);
    expect(routed).toEqual([]);
  });

  it('never moves the watermark from snapshot or backfill frames', async () => {
    assign(1);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);

    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      backfillEvent([hyperliquidFill('BTC', 'B', '1', '0', 0)]),
    );

    expect(fake.watermarks).toEqual([]);
    expect(routed[0][0].source).toBe('backfill');
  });

  it('stores fills of a wallet the session no longer holds without signals or watermark', async () => {
    assign(1);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);
    syncState.markAssigned(SESSION, 2, []);

    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'B', '1', '0', 0)]),
    );
    await syncState.completeSync(SESSION, CLUSTER, WALLET);

    expect(fake.rows).toHaveLength(1);
    expect(fake.watermarks).toEqual([]);
    expect(routed).toEqual([]);
  });

  it('treats a wallet added back to the session as unsynced', async () => {
    assign(1);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);
    syncState.markAssigned(SESSION, 2, []);
    syncState.markAssignApplied(SESSION, 2);

    assign(3, false);

    expect(syncState.readWallet(SESSION, WALLET)).toEqual(
      expect.objectContaining({ isSynced: false, addedInVersion: 3 }),
    );
  });

  it('records the fill latency of stream fills', async () => {
    assign(1);

    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'B', '1', '0', 0)]),
    );

    const histogram = await metrics.fillLatencyMs.get();
    const count = histogram.values.find(
      (value) => value.metricName === 'remora_fill_latency_ms_count',
    );
    const sum = histogram.values.find(
      (value) => value.metricName === 'remora_fill_latency_ms_sum',
    );
    expect(count?.value).toBe(1);
    expect(sum?.value).toBe(250);
  });

  it('keeps the synced gate when assigned of an older version arrives again', async () => {
    assign(1);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);
    syncState.markAssigned(SESSION, 2, [
      { address: WALLET, trackedSince: TRACKED_SINCE },
      { address: OTHER_WALLET, trackedSince: TRACKED_SINCE },
    ]);
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'B', '1', '0', 0)], OTHER_WALLET),
    );

    syncState.markAssignApplied(SESSION, 1);
    syncState.markAssignApplied(SESSION, 1);
    await syncState.completeSync(SESSION, CLUSTER, OTHER_WALLET);

    expect(syncState.readWallet(SESSION, WALLET)?.isSynced).toBe(true);
    expect(syncState.readWallet(SESSION, OTHER_WALLET)?.isSynced).toBe(false);
    expect(fake.watermarks).toEqual([]);
    expect(routed).toEqual([]);

    syncState.markAssignApplied(SESSION, 2);
    syncState.markAssignApplied(SESSION, 2);
    await syncState.completeSync(SESSION, CLUSTER, OTHER_WALLET);
    await syncState.completeSync(SESSION, CLUSTER, OTHER_WALLET);

    expect(syncState.readWallet(SESSION, OTHER_WALLET)).toEqual(
      expect.objectContaining({ isSynced: true, addedInVersion: 2 }),
    );
    expect(syncState.readWallet(SESSION, WALLET)).toEqual(
      expect.objectContaining({ isSynced: true, addedInVersion: 1 }),
    );
    expect(fake.watermarks).toEqual([new Date(START)]);
    expect(routed).toHaveLength(1);
  });

  it('turns only the wallets a syncStarted names unsynced', async () => {
    syncState.markAssigned(SESSION, 1, [
      { address: WALLET, trackedSince: TRACKED_SINCE },
      { address: OTHER_WALLET, trackedSince: TRACKED_SINCE },
    ]);
    syncState.markAssignApplied(SESSION, 1);
    await syncState.completeSync(SESSION, CLUSTER, WALLET);
    await syncState.completeSync(SESSION, CLUSTER, OTHER_WALLET);

    syncState.markSyncStarted(SESSION, [OTHER_WALLET]);
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent([hyperliquidFill('BTC', 'B', '1', '0', 1_000)]),
    );
    await ingestion.ingestFills(
      SESSION,
      CLUSTER,
      streamEvent(
        [hyperliquidFill('HYPE', 'B', '2', '0', 2_000)],
        OTHER_WALLET,
      ),
    );

    expect(syncState.readWallet(SESSION, WALLET)?.isSynced).toBe(true);
    expect(syncState.readWallet(SESSION, OTHER_WALLET)?.isSynced).toBe(false);
    expect(fake.watermarks).toEqual([new Date(START + 1_000)]);
    expect(routed).toHaveLength(1);
    expect(routed[0][0]).toMatchObject({ wallet: WALLET, source: 'stream' });
  });

  it('forgets the state of a session that ended', () => {
    assign(1);

    syncState.endSession(SESSION);

    expect(syncState.readWallet(SESSION, WALLET)).toBeNull();
  });
});
