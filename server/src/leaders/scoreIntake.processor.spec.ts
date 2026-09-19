import { Logger } from '@nestjs/common';
import type { RunFinishedJob, WalletScoredJob } from '@remora/sdk';
import { type Job, type Queue, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ScoreIntakeProcessor,
  ScoresPendingError,
} from './scoreIntake.processor';

Logger.overrideLogger(false);

const RUN_ID = 'run-20260420T0200Z';
const WALLET = '0xad5455057feac38a2dd2210d0fac0854d1eb6203';

function walletScored(
  score: Partial<WalletScoredJob['score']> = {},
): WalletScoredJob {
  return {
    runId: RUN_ID,
    startedAt: '2026-04-20T02:00:00.000Z',
    modelVersion: 1,
    score: {
      walletAddress: WALLET,
      stage: 2,
      passed: false,
      gateFailures: ['short_history'],
      preliminary: null,
      composite: null,
      accountValueUsd: '1029082.251',
      historyDays: 120,
      periods: 17,
      psr: 0.7,
      dsr: 0.1,
      maxDrawdown: -0.2,
      edgeBps: 60,
      sortino30d: 0.3,
      positiveShare: 0.55,
      perpPnlShare: 0.9,
      holdMinutes: null,
      ordersPerDay: null,
      makerShare: null,
      coreNotionalShare: null,
      fillsWindowFrom: null,
      components: null,
      ...score,
    },
  };
}

function runFinished(expectedScores: number): RunFinishedJob {
  return {
    runId: RUN_ID,
    startedAt: '2026-04-20T02:00:00.000Z',
    finishedAt: '2026-04-20T03:12:00.000Z',
    modelVersion: 1,
    expectedScores,
    leaderboardRows: 46_934,
    stageOneCount: 1_629,
    stageTwoCount: expectedScores,
    stageThreeCount: 100,
  };
}

function createProcessor(storedScores = 0) {
  const prisma = {
    $transaction: vi.fn((operations: Promise<unknown>[]) =>
      Promise.all(operations),
    ),
    scoringRun: {
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    wallet: { upsert: vi.fn().mockResolvedValue({}) },
    walletScore: {
      upsert: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(storedScores),
    },
  };
  const selectionQueue = { add: vi.fn().mockResolvedValue({}) };
  const processor = new ScoreIntakeProcessor(
    prisma as unknown as PrismaService,
    selectionQueue as unknown as Queue,
  );
  return { processor, prisma, selectionQueue };
}

function job(name: string, data: unknown): Job {
  return { name, data, id: '1' } as unknown as Job;
}

describe('ScoreIntakeProcessor', () => {
  it('creates the run and the candidate on the first score and upserts the score', async () => {
    const { processor, prisma } = createProcessor();

    await processor.process(job('wallet-scored', walletScored()));

    expect(prisma.scoringRun.upsert).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      create: {
        id: RUN_ID,
        modelVersion: 1,
        startedAt: new Date('2026-04-20T02:00:00.000Z'),
      },
      update: {},
    });
    expect(prisma.wallet.upsert).toHaveBeenCalledWith({
      where: { address: WALLET },
      create: { address: WALLET, source: 'LEADERBOARD' },
      update: {},
    });
    const scoreUpsert = prisma.walletScore.upsert.mock.calls[0][0] as {
      where: unknown;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(scoreUpsert.where).toEqual({
      runId_walletAddress: { runId: RUN_ID, walletAddress: WALLET },
    });
    expect(scoreUpsert.create).toMatchObject({
      runId: RUN_ID,
      walletAddress: WALLET,
      stage: 2,
      gateFailures: ['short_history'],
      accountValueUsd: '1029082.251',
      fillsWindowFrom: null,
    });
    expect(scoreUpsert.update.components).toBe(Prisma.DbNull);
  });

  it('stores the window and the components of a stage-three score', async () => {
    const { processor, prisma } = createProcessor();
    const components = [
      {
        name: 'significance' as const,
        raw: 0.9,
        winsorized: 0.9,
        percentile: 0.92,
        weight: 0.3,
        contribution: 0.276,
      },
    ];

    await processor.process(
      job(
        'wallet-scored',
        walletScored({
          stage: 3,
          fillsWindowFrom: '2026-03-21T02:00:00.000Z',
          components,
        }),
      ),
    );

    const scoreUpsert = prisma.walletScore.upsert.mock.calls[0][0] as {
      update: Record<string, unknown>;
    };
    expect(scoreUpsert.update).toMatchObject({
      stage: 3,
      fillsWindowFrom: new Date('2026-03-21T02:00:00.000Z'),
      components,
    });
  });

  it('refuses a malformed score without retrying', async () => {
    const { processor } = createProcessor();

    await expect(
      processor.process(
        job('wallet-scored', { ...walletScored(), runId: 'run:1' }),
      ),
    ).rejects.toThrow(UnrecoverableError);
  });

  it('stores the expected count and retries until every score is stored', async () => {
    const { processor, prisma, selectionQueue } = createProcessor(4);

    await expect(
      processor.process(job('run-finished', runFinished(5))),
    ).rejects.toThrow(ScoresPendingError);

    expect(prisma.scoringRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ expectedScores: 5 }) as unknown,
      }),
    );
    expect(prisma.scoringRun.update).not.toHaveBeenCalled();
    expect(selectionQueue.add).not.toHaveBeenCalled();
  });

  it('completes the run and queues selection once every score is stored', async () => {
    const { processor, prisma, selectionQueue } = createProcessor(5);

    await processor.process(job('run-finished', runFinished(5)));

    expect(prisma.scoringRun.update).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      data: { finishedAt: new Date('2026-04-20T03:12:00.000Z') },
    });
    expect(selectionQueue.add).toHaveBeenCalledWith(
      'select-leaders',
      { runId: RUN_ID },
      { jobId: `select-${RUN_ID}` },
    );
  });

  it('completes an empty run straight away', async () => {
    const { processor, selectionQueue } = createProcessor(0);

    await processor.process(job('run-finished', runFinished(0)));

    expect(selectionQueue.add).toHaveBeenCalledTimes(1);
  });
});
