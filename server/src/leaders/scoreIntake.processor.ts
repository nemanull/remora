import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import {
  parseRunFinishedJob,
  parseWalletScoredJob,
  type RunFinishedJob,
  type WalletScoredJob,
} from '@remora/sdk';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { Prisma } from '../generated/prisma/client';
import {
  RUN_FINISHED_JOB,
  SCORING_RESULTS_QUEUE,
  SELECT_LEADERS_JOB,
  SELECTION_QUEUE,
  WALLET_SCORED_JOB,
} from '../jobs/queues';
import { PrismaService } from '../prisma/prisma.service';

export class ScoresPendingError extends Error {
  constructor(runId: string, stored: number, expected: number) {
    super(
      `Run ${runId} holds ${stored} of ${expected} scores, waiting for the rest`,
    );
    this.name = 'ScoresPendingError';
  }
}

export function selectLeadersJobId(runId: string): string {
  return `select-${runId}`;
}

@Processor(SCORING_RESULTS_QUEUE, { concurrency: 1 })
export class ScoreIntakeProcessor extends WorkerHost {
  private readonly logger = new Logger(ScoreIntakeProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(SELECTION_QUEUE) private readonly selectionQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    try {
      if (job.name === WALLET_SCORED_JOB) {
        await this.storeScore(job.data);
      } else if (job.name === RUN_FINISHED_JOB) {
        await this.finishRun(job.data);
      } else {
        throw new UnrecoverableError(`Unknown scoring result job ${job.name}`);
      }
    } catch (error) {
      this.logFailure(job, error);
      throw error;
    }
  }

  private async storeScore(data: unknown): Promise<void> {
    const parsed = parseWalletScoredJob(data);
    if (!parsed.ok) {
      throw new UnrecoverableError(parsed.reason);
    }
    const { runId, startedAt, modelVersion, score } = parsed.message;
    const fields = this.readScoreFields(parsed.message);
    await this.prisma.$transaction([
      this.prisma.scoringRun.upsert({
        where: { id: runId },
        create: { id: runId, modelVersion, startedAt: new Date(startedAt) },
        update: {},
      }),
      this.prisma.wallet.upsert({
        where: { address: score.walletAddress },
        create: { address: score.walletAddress, source: 'LEADERBOARD' },
        update: {},
      }),
      this.prisma.walletScore.upsert({
        where: {
          runId_walletAddress: { runId, walletAddress: score.walletAddress },
        },
        create: { runId, walletAddress: score.walletAddress, ...fields },
        update: fields,
      }),
    ]);
    this.logger.debug(
      `Stored the stage ${score.stage} score of wallet ${score.walletAddress} for run ${runId}`,
    );
  }

  private async finishRun(data: unknown): Promise<void> {
    const parsed = parseRunFinishedJob(data);
    if (!parsed.ok) {
      throw new UnrecoverableError(parsed.reason);
    }
    const run: RunFinishedJob = parsed.message;
    const counts = {
      expectedScores: run.expectedScores,
      leaderboardRows: run.leaderboardRows,
      stageOneCount: run.stageOneCount,
      stageTwoCount: run.stageTwoCount,
      stageThreeCount: run.stageThreeCount,
    };
    await this.prisma.scoringRun.upsert({
      where: { id: run.runId },
      create: {
        id: run.runId,
        modelVersion: run.modelVersion,
        startedAt: new Date(run.startedAt),
        ...counts,
      },
      update: counts,
    });
    const stored = await this.prisma.walletScore.count({
      where: { runId: run.runId },
    });
    if (stored < run.expectedScores) {
      throw new ScoresPendingError(run.runId, stored, run.expectedScores);
    }
    await this.prisma.scoringRun.update({
      where: { id: run.runId },
      data: { finishedAt: new Date(run.finishedAt) },
    });
    await this.selectionQueue.add(
      SELECT_LEADERS_JOB,
      { runId: run.runId },
      { jobId: selectLeadersJobId(run.runId) },
    );
    this.logger.log(
      `Completed scoring run ${run.runId} with ${stored} scores and queued leader selection`,
    );
  }

  private readScoreFields({ score }: WalletScoredJob) {
    return {
      stage: score.stage,
      passed: score.passed,
      gateFailures: score.gateFailures,
      preliminary: score.preliminary,
      composite: score.composite,
      accountValueUsd: score.accountValueUsd,
      historyDays: score.historyDays,
      periods: score.periods,
      psr: score.psr,
      dsr: score.dsr,
      maxDrawdown: score.maxDrawdown,
      edgeBps: score.edgeBps,
      sortino30d: score.sortino30d,
      positiveShare: score.positiveShare,
      perpPnlShare: score.perpPnlShare,
      holdMinutes: score.holdMinutes,
      ordersPerDay: score.ordersPerDay,
      makerShare: score.makerShare,
      coreNotionalShare: score.coreNotionalShare,
      fillsWindowFrom:
        score.fillsWindowFrom === null ? null : new Date(score.fillsWindowFrom),
      components: score.components ?? Prisma.DbNull,
    };
  }

  private logFailure(job: Job, error: unknown): void {
    if (error instanceof ScoresPendingError) {
      this.logger.log(error.message);
      return;
    }
    this.logger.error(
      `Scoring result job ${job.name} ${job.id ?? ''} failed`,
      error instanceof Error ? error.stack : String(error),
    );
  }
}
