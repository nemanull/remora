import { ConfigService } from '@nestjs/config';
import type {
  RunFinishedJob,
  WalletScoredJob,
  WalletScorePayload,
} from '@remora/sdk';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { type Job, type Queue, UnrecoverableError } from 'bullmq';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  ScoreIntakeProcessor,
  ScoresPendingError,
} from '../src/leaders/scoreIntake.processor';
import { PrismaService } from '../src/prisma/prisma.service';
import { startMigratedPostgres } from './migratedPostgres';

const RUN_ID = 'run-20260502T0200Z';
const STARTED_AT = '2026-05-02T02:00:00.000Z';
const FIRST_WALLET = '0x1111111111111111111111111111111111111111';
const SECOND_WALLET = '0x2222222222222222222222222222222222222222';
const THIRD_WALLET = '0x3333333333333333333333333333333333333333';

function score(
  walletAddress: string,
  overrides: Partial<WalletScorePayload> = {},
): WalletScorePayload {
  return {
    walletAddress,
    stage: 3,
    passed: true,
    gateFailures: [],
    preliminary: 0.61,
    composite: 0.72,
    accountValueUsd: '1250000.50',
    historyDays: 214,
    periods: 30,
    psr: 0.93,
    dsr: 0.81,
    maxDrawdown: -0.14,
    edgeBps: 11.2,
    sortino30d: 2.4,
    positiveShare: 0.62,
    perpPnlShare: 0.97,
    holdMinutes: 340,
    ordersPerDay: 18,
    makerShare: 0.31,
    coreNotionalShare: 0.88,
    fillsWindowFrom: '2026-04-02T02:00:00.000Z',
    components: [
      {
        name: 'significance',
        raw: 0.93,
        winsorized: 0.93,
        percentile: 0.8,
        weight: 0.3,
        contribution: 0.24,
      },
    ],
    ...overrides,
  };
}

function scoredJob(payload: WalletScorePayload): Job {
  const data: WalletScoredJob = {
    runId: RUN_ID,
    startedAt: STARTED_AT,
    modelVersion: 1,
    score: payload,
  };
  return {
    id: `${RUN_ID}-${payload.walletAddress}`,
    name: 'wallet-scored',
    data,
  } as Job;
}

function finishedJob(expectedScores: number): Job {
  const data: RunFinishedJob = {
    runId: RUN_ID,
    startedAt: STARTED_AT,
    finishedAt: '2026-05-02T03:41:00.000Z',
    modelVersion: 1,
    expectedScores,
    leaderboardRows: 47_410,
    stageOneCount: 1_717,
    stageTwoCount: 3,
    stageThreeCount: 2,
  };
  return { id: `${RUN_ID}-finished`, name: 'run-finished', data } as Job;
}

describe('ScoreIntakeProcessor on Postgres', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let selectionQueue: { add: ReturnType<typeof vi.fn> };
  let processor: ScoreIntakeProcessor;

  beforeAll(async () => {
    container = await startMigratedPostgres();
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: container.getConnectionUri() }),
    );
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await prisma.walletScore.deleteMany();
    await prisma.scoringRun.deleteMany();
    await prisma.wallet.deleteMany();
    selectionQueue = { add: vi.fn().mockResolvedValue(undefined) };
    processor = new ScoreIntakeProcessor(
      prisma,
      selectionQueue as unknown as Queue,
    );
  });

  it('stores one score per wallet and run, and completes the run once every expected score is in', async () => {
    await processor.process(scoredJob(score(FIRST_WALLET, { composite: 0.5 })));
    await processor.process(scoredJob(score(SECOND_WALLET)));
    await processor.process(
      scoredJob(score(FIRST_WALLET, { composite: 0.72 })),
    );

    await expect(processor.process(finishedJob(3))).rejects.toBeInstanceOf(
      ScoresPendingError,
    );
    const pending = await prisma.scoringRun.findUniqueOrThrow({
      where: { id: RUN_ID },
    });
    expect(pending.finishedAt).toBeNull();
    expect(pending.expectedScores).toBe(3);
    expect(pending.leaderboardRows).toBe(47_410);
    expect(selectionQueue.add).not.toHaveBeenCalled();

    await processor.process(
      scoredJob(
        score(THIRD_WALLET, {
          stage: 2,
          passed: false,
          gateFailures: ['spot_driven'],
          composite: null,
          components: null,
        }),
      ),
    );
    await processor.process(finishedJob(3));

    const finished = await prisma.scoringRun.findUniqueOrThrow({
      where: { id: RUN_ID },
    });
    expect(finished.finishedAt?.toISOString()).toBe('2026-05-02T03:41:00.000Z');
    expect(selectionQueue.add).toHaveBeenCalledWith(
      'select-leaders',
      { runId: RUN_ID },
      { jobId: `select-${RUN_ID}` },
    );
    const scores = await prisma.walletScore.findMany({
      where: { runId: RUN_ID },
      orderBy: { walletAddress: 'asc' },
    });
    expect(scores.map((row) => [row.walletAddress, row.composite])).toEqual([
      [FIRST_WALLET, 0.72],
      [SECOND_WALLET, 0.72],
      [THIRD_WALLET, null],
    ]);
    expect(scores[0].accountValueUsd.toString()).toBe('1250000.5');
    expect(scores[2].gateFailures).toEqual(['spot_driven']);
    expect(scores[2].components).toBeNull();
    const wallets = await prisma.wallet.findMany({
      orderBy: { address: 'asc' },
    });
    expect(wallets.map((wallet) => [wallet.source, wallet.status])).toEqual([
      ['LEADERBOARD', 'CANDIDATE'],
      ['LEADERBOARD', 'CANDIDATE'],
      ['LEADERBOARD', 'CANDIDATE'],
    ]);
  });

  it('keeps the source and status of a wallet that is already registered', async () => {
    await prisma.wallet.create({
      data: { address: FIRST_WALLET, source: 'MANUAL', status: 'SHADOW' },
    });

    await processor.process(scoredJob(score(FIRST_WALLET)));

    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { address: FIRST_WALLET },
    });
    expect(wallet.source).toBe('MANUAL');
    expect(wallet.status).toBe('SHADOW');
  });

  it('refuses a malformed score as unrecoverable and stores nothing', async () => {
    const job = scoredJob(score(FIRST_WALLET));
    job.data = {
      runId: RUN_ID,
      startedAt: STARTED_AT,
      modelVersion: 1,
      score: { walletAddress: 'not an address' },
    };

    await expect(processor.process(job)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(await prisma.scoringRun.count()).toBe(0);
    expect(await prisma.walletScore.count()).toBe(0);
  });
});
