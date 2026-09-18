import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import {
  RUN_FINISHED_JOB,
  type RunFinishedJob,
  SCORING_RESULTS_QUEUE,
  type ScoreComponent,
  WALLET_SCORED_JOB,
  type WalletScoredJob,
  type WalletScorePayload,
} from '@remora/sdk';
import { type JobsOptions, Queue } from 'bullmq';
import {
  isStageThreeResult,
  type StageThreeResult,
  type StageTwoResult,
} from '../scoring/walletScorer';

const RESULT_JOB_OPTIONS: JobsOptions = {
  attempts: 10,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 5_000 },
  removeOnFail: { count: 5_000 },
};

export type ScoreRanking = {
  preliminary: number | null;
  composite: number | null;
  components: ScoreComponent[] | null;
  dsr: number | null;
};

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function buildScorePayload(
  result: StageTwoResult | StageThreeResult,
  ranking: ScoreRanking,
): WalletScorePayload {
  const behaviour = isStageThreeResult(result) ? result : null;
  return {
    walletAddress: result.address,
    stage: behaviour === null ? 2 : 3,
    passed: result.gateFailures.length === 0,
    gateFailures: result.gateFailures,
    preliminary: finiteOrNull(ranking.preliminary),
    composite: finiteOrNull(ranking.composite),
    accountValueUsd: result.accountValueUsd,
    historyDays: result.historyDays,
    periods: result.periods,
    psr: finiteOrNull(result.psr),
    dsr: finiteOrNull(ranking.dsr),
    maxDrawdown: finiteOrNull(result.maxDrawdown),
    edgeBps: finiteOrNull(result.edgeBps),
    sortino30d: finiteOrNull(result.sortino30d),
    positiveShare: finiteOrNull(result.positiveShare),
    perpPnlShare: finiteOrNull(result.perpPnlShare),
    holdMinutes: finiteOrNull(behaviour?.holdMinutes ?? null),
    ordersPerDay: finiteOrNull(behaviour?.ordersPerDay ?? null),
    makerShare: finiteOrNull(behaviour?.makerShare ?? null),
    coreNotionalShare: finiteOrNull(behaviour?.coreNotionalShare ?? null),
    fillsWindowFrom:
      behaviour === null
        ? null
        : new Date(behaviour.fillsWindowFrom).toISOString(),
    components:
      ranking.components?.map((component) => ({
        ...component,
        raw: finiteOrNull(component.raw),
        winsorized: finiteOrNull(component.winsorized),
      })) ?? null,
  };
}

@Injectable()
export class ScoringResults {
  constructor(
    @InjectQueue(SCORING_RESULTS_QUEUE) private readonly queue: Queue,
  ) {}

  async sendWalletScore(job: WalletScoredJob): Promise<void> {
    await this.queue.add(WALLET_SCORED_JOB, job, {
      ...RESULT_JOB_OPTIONS,
      jobId: `${job.runId}-${job.score.walletAddress}`,
    });
  }

  async sendRunFinished(job: RunFinishedJob): Promise<void> {
    await this.queue.add(RUN_FINISHED_JOB, job, {
      ...RESULT_JOB_OPTIONS,
      jobId: `${job.runId}-finished`,
    });
  }
}
