import type { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type {
  DecisionsPageResponse,
  LeaderResponse,
  OverviewResponse,
  ScoreComponent,
} from '@remora/sdk';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  RedisContainer,
  type StartedRedisContainer,
} from '@testcontainers/redis';
import { Decimal } from 'decimal.js';
import type { Server } from 'node:http';
import { NEVER } from 'rxjs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiModule } from '../src/api/api.module';
import { validateServerConfig } from '../src/config';
import { CopyEventsModule } from '../src/copy/copyEvents.module';
import { JobsModule } from '../src/jobs/jobs.module';
import { MarketDataService } from '../src/market/marketData.service';
import { MetricsModule } from '../src/metrics/metrics.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { startMigratedPostgres } from './migratedPostgres';

const LIVE_LEADER = '0x1111111111111111111111111111111111111111';
const SHADOW_LEADER = '0x2222222222222222222222222222222222222222';
const STRONG_CANDIDATE = '0x3333333333333333333333333333333333333333';
const WEAK_CANDIDATE = '0x4444444444444444444444444444444444444444';
const RETIRED_LEADER = '0x5555555555555555555555555555555555555555';
const UNKNOWN_WALLET = '0x6666666666666666666666666666666666666666';

const LIVE_SINCE = new Date('2026-04-01T00:00:00.000Z');
const EPISODE_START = new Date('2026-04-10T12:00:00.000Z');
const TRACE = [
  {
    policy: 'instrument',
    outcome: 'allow',
    reason: null,
    detail: 'ETH is a main-dex perp with cross margin',
  },
  {
    policy: 'kill_switch',
    outcome: 'skip',
    reason: null,
    detail: 'not applied in the shadow book',
  },
];
const COMPONENTS: ScoreComponent[] = [
  {
    name: 'significance',
    raw: 0.93,
    winsorized: 0.93,
    percentile: 0.9,
    weight: 0.3,
    contribution: 0.27,
  },
  {
    name: 'drawdown',
    raw: -0.12,
    winsorized: -0.12,
    percentile: 0.7,
    weight: 0.2,
    contribution: 0.14,
  },
];

function minutesAfterStart(minutes: number): Date {
  return new Date(EPISODE_START.getTime() + minutes * 60_000);
}

async function seed(prisma: PrismaService): Promise<void> {
  await prisma.wallet.createMany({
    data: [
      {
        address: LIVE_LEADER,
        status: 'LIVE',
        source: 'LEADERBOARD',
        score: 0.7,
        trackedSince: new Date('2026-03-01T00:00:00.000Z'),
        liveSince: LIVE_SINCE,
      },
      {
        address: SHADOW_LEADER,
        status: 'SHADOW',
        source: 'MANUAL',
        trackedSince: new Date('2026-04-05T00:00:00.000Z'),
      },
      { address: STRONG_CANDIDATE, source: 'LEADERBOARD', score: 0.9 },
      { address: WEAK_CANDIDATE, source: 'LEADERBOARD', score: 0.4 },
      {
        address: RETIRED_LEADER,
        status: 'RETIRED',
        source: 'LEADERBOARD',
        score: 0.95,
        retiredAt: new Date('2026-04-02T00:00:00.000Z'),
      },
    ],
  });
  await prisma.scoringRun.createMany({
    data: [
      {
        id: 'run-20260408T0200Z',
        modelVersion: 1,
        startedAt: new Date('2026-04-08T02:00:00.000Z'),
        finishedAt: new Date('2026-04-08T03:40:00.000Z'),
        expectedScores: 2,
      },
      {
        id: 'run-20260409T0200Z',
        modelVersion: 1,
        startedAt: new Date('2026-04-09T02:00:00.000Z'),
      },
    ],
  });
  const score = {
    stage: 3,
    passed: true,
    gateFailures: [],
    accountValueUsd: '250000.00',
    historyDays: 400,
    periods: 52,
  };
  await prisma.walletScore.create({
    data: {
      ...score,
      runId: 'run-20260408T0200Z',
      walletAddress: LIVE_LEADER,
      composite: 0.6,
      createdAt: new Date('2026-04-08T03:00:00.000Z'),
    },
  });
  await prisma.walletScore.create({
    data: {
      ...score,
      runId: 'run-20260409T0200Z',
      walletAddress: LIVE_LEADER,
      composite: 0.41,
      components: COMPONENTS,
      createdAt: new Date('2026-04-09T03:00:00.000Z'),
    },
  });
  const fill = {
    walletAddress: LIVE_LEADER,
    coin: 'ETH',
    hash: '0x00',
    crossed: true,
    source: 'STREAM' as const,
  };
  await prisma.leaderFill.createMany({
    data: [
      {
        ...fill,
        tid: 101n,
        oid: 1n,
        px: '2000',
        sz: '10',
        side: 'B',
        startPosition: '0',
        dir: 'Open Long',
        closedPnl: '0',
        fee: '9',
        time: minutesAfterStart(0),
        receivedAt: minutesAfterStart(0),
      },
      {
        ...fill,
        tid: 102n,
        oid: 2n,
        px: '2100',
        sz: '5',
        side: 'B',
        startPosition: '10',
        dir: 'Open Long',
        closedPnl: '0',
        fee: '4.725',
        time: minutesAfterStart(30),
        receivedAt: minutesAfterStart(30),
      },
      {
        ...fill,
        tid: 103n,
        oid: 3n,
        px: '2200',
        sz: '15',
        side: 'A',
        startPosition: '15',
        dir: 'Close Long',
        closedPnl: '2500',
        fee: '14.85',
        time: minutesAfterStart(90),
        receivedAt: minutesAfterStart(90),
      },
      {
        ...fill,
        tid: 104n,
        oid: 4n,
        px: '2300',
        sz: '3',
        side: 'B',
        startPosition: '0',
        dir: 'Open Long',
        closedPnl: '0',
        fee: '3.105',
        time: minutesAfterStart(240),
        receivedAt: minutesAfterStart(240),
      },
    ],
  });
  const copy = await prisma.copyPosition.create({
    data: {
      book: 'MAIN',
      walletAddress: LIVE_LEADER,
      coin: 'ETH',
      size: '0',
      entryPx: '2034.666666667',
      ratio: '0.01',
      leaderSizeAtSync: '0',
      allocationUsd: '5000',
      isOpen: false,
      openedAt: minutesAfterStart(0),
      lastOrderAt: minutesAfterStart(91),
      closedAt: minutesAfterStart(91),
      closeReason: 'leader_closed',
      realizedPnl: '24.5',
      feesUsd: '0.285705',
      fundingUsd: '-0.12',
      leaderOpenTid: 101n,
    },
  });
  const decision = {
    book: 'MAIN' as const,
    walletAddress: LIVE_LEADER,
    coin: 'ETH',
    signalSource: 'stream',
    verdict: 'COPY' as const,
    reason: 'copied',
    trace: TRACE,
  };
  const decisionIds: bigint[] = [];
  for (const row of [
    { key: 101, action: 'OPEN', before: '0', after: '10', vwap: '2000', at: 0 },
    {
      key: 102,
      action: 'INCREASE',
      before: '10',
      after: '15',
      vwap: '2100',
      at: 30,
    },
    {
      key: 103,
      action: 'CLOSE',
      before: '15',
      after: '0',
      vwap: '2200',
      at: 90,
    },
  ] as const) {
    const stored = await prisma.copyDecision.create({
      data: {
        ...decision,
        signalKey: `${LIVE_LEADER}-ETH-${row.key}`,
        action: row.action,
        positionBefore: row.before,
        positionAfter: row.after,
        leaderVwap: row.vwap,
        leaderTime: minutesAfterStart(row.at),
        receivedAt: minutesAfterStart(row.at),
        decidedAt: minutesAfterStart(row.at),
      },
    });
    decisionIds.push(stored.id);
  }
  const [openedId, increasedId, closedId] = decisionIds;
  const order = {
    book: 'MAIN' as const,
    coin: 'ETH',
    positionId: copy.id,
    status: 'FILLED' as const,
  };
  await prisma.order.createMany({
    data: [
      {
        ...order,
        decisionId: openedId,
        cloid: '0x01',
        isBuy: true,
        size: '0.1',
        limitPx: '2010',
        reduceOnly: false,
        purpose: 'ENTRY',
        filledSize: '0.1',
        avgPx: '2001',
        feeUsd: '0.090045',
        slippageBps: 5,
        submittedAt: minutesAfterStart(0),
      },
      {
        ...order,
        decisionId: increasedId,
        cloid: '0x02',
        isBuy: true,
        size: '0.05',
        limitPx: '2110',
        reduceOnly: false,
        purpose: 'ENTRY',
        filledSize: '0.05',
        avgPx: '2102',
        feeUsd: '0.047295',
        slippageBps: (2 / 2100) * 10_000,
        submittedAt: minutesAfterStart(30),
      },
      {
        ...order,
        decisionId: closedId,
        cloid: '0x03',
        isBuy: false,
        size: '0.15',
        limitPx: '2180',
        reduceOnly: true,
        purpose: 'EXIT',
        status: 'UNFILLED',
        submittedAt: minutesAfterStart(90),
      },
      {
        ...order,
        decisionId: null,
        cloid: '0x04',
        isBuy: false,
        size: '0.15',
        limitPx: '2130',
        reduceOnly: true,
        purpose: 'EXIT',
        attempt: 2,
        filledSize: '0.15',
        avgPx: '2198',
        feeUsd: '0.148365',
        slippageBps: (2 / 2200) * 10_000,
        submittedAt: minutesAfterStart(91),
      },
    ],
  });
  for (const [index, reason] of [
    'stale_signal',
    'price_drift',
    'below_min_notional',
  ].entries()) {
    await prisma.copyDecision.create({
      data: {
        book: 'SHADOW',
        walletAddress: SHADOW_LEADER,
        coin: 'SOL',
        signalKey: `${SHADOW_LEADER}-SOL-${200 + index}`,
        signalSource: 'stream',
        action: 'OPEN',
        positionBefore: '0',
        positionAfter: '12',
        leaderVwap: '140',
        leaderTime: minutesAfterStart(300 + index),
        receivedAt: minutesAfterStart(300 + index),
        decidedAt: minutesAfterStart(300 + index),
        verdict: 'SKIP',
        reason,
        trace: TRACE,
      },
    });
  }
}

describe('the dashboard API', () => {
  let postgres: StartedPostgreSqlContainer;
  let redis: StartedRedisContainer;
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      startMigratedPostgres(),
      new RedisContainer('redis:8.6.3').start(),
    ]);
    const config = validateServerConfig({
      DATABASE_URL: postgres.getConnectionUri(),
      REDIS_URL: redis.getConnectionUrl(),
      HYPERLIQUID_API_URL: 'http://127.0.0.1:9',
      HYPERLIQUID_WS_URL: 'ws://127.0.0.1:9/ws',
      CLUSTER_TOKEN_HASHES: `1:${'a'.repeat(64)}`,
    });
    const market = {
      coin: 'ETH',
      assetIndex: 1,
      szDecimals: 4,
      maxLeverage: 25,
      isOnlyIsolated: false,
      marginMode: null,
      fundingRate: new Decimal('0.0000125'),
      markPrice: new Decimal('2250'),
      oraclePrice: new Decimal('2250'),
    };
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
        JobsModule,
        ApiModule,
      ],
    })
      .overrideProvider(MarketDataService)
      .useValue({
        mids$: NEVER,
        hasMarkets: () => true,
        readMarkets: () => new Map([['ETH', market]]),
        readMarket: (coin: string) => (coin === 'ETH' ? market : null),
        readMid: (coin: string) =>
          coin === 'ETH'
            ? { price: new Decimal('2250'), receivedAt: new Date() }
            : null,
        readMarketsRefreshedAt: () => new Date(),
        refreshMarkets: () => Promise.resolve(1),
      })
      .compile();
    await seed(moduleRef.get(PrismaService));
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  it('lists live and shadow leaders first, then the rest by score', async () => {
    const response = await request(server).get('/api/leaders').expect(200);
    const leaders = response.body as LeaderResponse[];

    expect(leaders.map((leader) => leader.address)).toEqual([
      LIVE_LEADER,
      SHADOW_LEADER,
      STRONG_CANDIDATE,
      WEAK_CANDIDATE,
      RETIRED_LEADER,
    ]);
    expect(leaders[0]).toMatchObject({
      status: 'LIVE',
      score: 0.7,
      lastFillAt: minutesAfterStart(240).toISOString(),
      openCopies: 0,
      copyResults: { book: 'MAIN', closedCopies: 1 },
      latestScore: {
        runId: 'run-20260409T0200Z',
        composite: 0.41,
        components: COMPONENTS,
      },
    });
    expect(leaders[0].copyResults?.netPnlUsd).toBeCloseTo(24.094295, 6);
    expect(leaders[1]).toMatchObject({
      source: 'MANUAL',
      latestScore: null,
      copyResults: { book: 'SHADOW', closedCopies: 0 },
    });
  });

  it('filters the leaders by status and refuses an unknown one', async () => {
    const candidates = await request(server)
      .get('/api/leaders?status=candidate')
      .expect(200);
    expect(
      (candidates.body as LeaderResponse[]).map((leader) => leader.address),
    ).toEqual([STRONG_CANDIDATE, WEAK_CANDIDATE]);

    const refused = await request(server)
      .get('/api/leaders?status=famous')
      .expect(400);
    expect(refused.body).toMatchObject({ reason: 'invalid_query' });
  });

  it('pages the decisions by id, newest first, with their orders', async () => {
    const first = await request(server)
      .get('/api/decisions?limit=4')
      .expect(200);
    const firstPage = first.body as DecisionsPageResponse;
    expect(firstPage.decisions.map((decision) => decision.reason)).toEqual([
      'below_min_notional',
      'price_drift',
      'stale_signal',
      'copied',
    ]);
    expect(firstPage.nextCursor).toBe(firstPage.decisions[3].id);
    expect(firstPage.decisions[0].trace).toEqual(TRACE);

    const second = await request(server)
      .get(`/api/decisions?limit=4&cursor=${firstPage.nextCursor}`)
      .expect(200);
    const secondPage = second.body as DecisionsPageResponse;
    expect(secondPage.decisions.map((decision) => decision.action)).toEqual([
      'INCREASE',
      'OPEN',
    ]);
    expect(secondPage.nextCursor).toBe(null);
    expect(secondPage.decisions[1].orders).toEqual([
      expect.objectContaining({
        cloid: '0x01',
        purpose: 'ENTRY',
        status: 'FILLED',
        filledSize: '0.1',
        avgPx: '2001',
        positionId: expect.any(String) as string,
      }),
    ]);
  });

  it('filters the decisions by book, verdict and reason', async () => {
    const copied = await request(server)
      .get('/api/decisions?book=main&verdict=COPY')
      .expect(200);
    expect((copied.body as DecisionsPageResponse).decisions).toHaveLength(3);

    const drifted = await request(server)
      .get('/api/decisions?reason=price_drift')
      .expect(200);
    expect(
      (drifted.body as DecisionsPageResponse).decisions.map(
        (decision) => decision.walletAddress,
      ),
    ).toEqual([SHADOW_LEADER]);
  });

  it('answers 404 for a wallet nobody registered', async () => {
    const response = await request(server)
      .get(`/api/leaders/${UNKNOWN_WALLET}`)
      .expect(404);
    expect(response.body).toMatchObject({ reason: 'wallet_not_found' });
  });

  it('runs a lifecycle action and reports a rejection with its reason', async () => {
    const paused = await request(server)
      .post(`/api/leaders/${SHADOW_LEADER}/pause`)
      .expect(200);
    expect(paused.body).toMatchObject({ isPaused: true });

    const rejected = await request(server)
      .post(`/api/leaders/${SHADOW_LEADER}/pause`)
      .expect(409);
    expect(rejected.body).toMatchObject({ reason: 'already_paused' });

    const invalid = await request(server)
      .post('/api/leaders')
      .send({ wallet: SHADOW_LEADER })
      .expect(400);
    expect(invalid.body).toMatchObject({ reason: 'invalid_body' });
  });

  it('sets and clears the kill switch', async () => {
    const set = await request(server)
      .post('/api/books/main/kill-switch')
      .send({ active: true, reason: 'maintenance' })
      .expect(200);
    expect(set.body).toEqual({ active: true, reason: 'maintenance' });

    const overview = await request(server).get('/api/overview').expect(200);
    expect(overview.body).toMatchObject({
      mode: 'paper',
      killSwitch: { active: true, reason: 'maintenance' },
      leaderCounts: { LIVE: 1, SHADOW: 1, CANDIDATE: 2, RETIRED: 1 },
      lastScoringRun: { id: 'run-20260409T0200Z', storedScores: 1 },
    });

    const cleared = await request(server)
      .post('/api/books/main/kill-switch')
      .send({ active: false })
      .expect(200);
    expect(cleared.body).toEqual({ active: false, reason: null });
  });

  it('reports the shadow book as cumulative net PnL beside the main book equity', async () => {
    const prisma = app.get(PrismaService);
    const shadowCopy = {
      book: 'SHADOW' as const,
      walletAddress: SHADOW_LEADER,
      coin: 'ETH',
      ratio: '0.01',
      leaderSizeAtSync: '20',
      allocationUsd: '5000',
      openedAt: minutesAfterStart(400),
      leaderOpenTid: 900n,
    };
    const created = await Promise.all([
      prisma.copyPosition.create({
        data: {
          ...shadowCopy,
          size: '0.2',
          entryPx: '2200',
          realizedPnl: '3',
          feesUsd: '0.5',
          fundingUsd: '0.1',
        },
      }),
      prisma.copyPosition.create({
        data: {
          ...shadowCopy,
          size: '0',
          isOpen: false,
          closedAt: minutesAfterStart(410),
          closeReason: 'leader_closed',
          realizedPnl: '-7',
          feesUsd: '0.4',
        },
      }),
    ]);
    const snapshot = await prisma.bookSnapshot.create({
      data: {
        book: 'SHADOW',
        takenAt: new Date(),
        equityUsd: '5.2',
        unrealizedPnl: '10',
        realizedPnlToday: '0',
        grossExposureUsd: '450',
        openPositions: 1,
      },
    });
    try {
      const overview = await request(server).get('/api/overview').expect(200);
      expect((overview.body as OverviewResponse).books).toEqual([
        expect.objectContaining({ book: 'MAIN', valueKind: 'equity' }),
        expect.objectContaining({
          book: 'SHADOW',
          valueKind: 'net_pnl',
          valueUsd: '5.20',
          unrealizedPnl: '10.00',
          openPositions: 1,
        }),
      ]);
      const points = await request(server)
        .get('/api/books/shadow/equity')
        .expect(200);
      expect(points.body).toEqual([
        expect.objectContaining({ valueKind: 'net_pnl', valueUsd: '5.2' }),
      ]);
    } finally {
      await prisma.bookSnapshot.delete({
        where: { book_takenAt: { book: 'SHADOW', takenAt: snapshot.takenAt } },
      });
      await prisma.copyPosition.deleteMany({
        where: { id: { in: created.map((copy) => copy.id) } },
      });
    }
  });

  it('serves liveness and metrics outside the API prefix', async () => {
    await request(server).get('/health').expect(200, { status: 'ok' });
    const metrics = await request(server).get('/metrics').expect(200);
    expect(metrics.text).toContain('remora_decisions_total');
  });
});
