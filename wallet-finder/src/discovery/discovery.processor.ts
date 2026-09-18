import { Processor, WorkerHost } from '@nestjs/bullmq';
import { BeforeApplicationShutdown, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DISCOVERY_QUEUE,
  parseRunDiscoveryJob,
  RateLimitedError,
  RUN_DISCOVERY_JOB,
  type RunDiscoveryJob,
} from '@remora/sdk';
import { Job, UnrecoverableError } from 'bullmq';
import type { WalletFinderConfig } from '../config';
import { MetricsService, PROCESS_LABEL } from '../metrics/metrics.service';
import {
  FINAL_COMPONENTS,
  PRELIMINARY_COMPONENTS,
  rankCohort,
  type RankedScore,
} from '../scoring/compositeScore';
import {
  computeDeflatedBenchmark,
  computeProbabilisticSharpe,
} from '../scoring/sharpeStatistics';
import {
  isStageThreeResult,
  type StageThreeResult,
  type StageTwoResult,
  UnreadableResponseError,
  WalletScorer,
} from '../scoring/walletScorer';
import { buildScorePayload, ScoringResults } from './scoringResults';
import { planStageTwo, type StageTwoTarget } from './stageOne';
import { StatsDataFiles } from './statsDataFiles';

const WALLET_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;
const PROGRESS_EVERY = 10;

export type DiscoverySummary = {
  runId: string;
  leaderboardRows: number;
  stageOneCount: number;
  stageTwoCount: number;
  stageThreeCount: number;
  expectedScores: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function selectStageThree(
  stageTwo: StageTwoResult[],
  preliminary: ReadonlyMap<string, RankedScore>,
  size: number,
): Set<string> {
  const best = [...preliminary.entries()]
    .sort(
      ([leftAddress, left], [rightAddress, right]) =>
        right.composite - left.composite ||
        leftAddress.localeCompare(rightAddress),
    )
    .slice(0, size)
    .map(([address]) => address);
  const tracked = stageTwo
    .filter((result) => result.isTracked)
    .map((result) => result.address);
  return new Set([...best, ...tracked]);
}

function cohortOf(results: StageTwoResult[]) {
  return new Map(
    results
      .filter((result) => result.gateFailures.length === 0)
      .map((result) => [result.address, result.components]),
  );
}

@Processor(DISCOVERY_QUEUE)
export class DiscoveryProcessor
  extends WorkerHost
  implements BeforeApplicationShutdown
{
  private readonly logger = new Logger(DiscoveryProcessor.name);
  private readonly shutdown = new AbortController();
  private readonly stageThreeSize: number;
  private readonly stageOneLimit: number | undefined;
  private readonly modelVersion: number;

  constructor(
    private readonly statsDataFiles: StatsDataFiles,
    private readonly scorer: WalletScorer,
    private readonly scoringResults: ScoringResults,
    private readonly metrics: MetricsService,
    config: ConfigService<WalletFinderConfig, true>,
  ) {
    super();
    this.stageThreeSize = config.getOrThrow('STAGE_THREE_SIZE', {
      infer: true,
    });
    this.stageOneLimit = config.get('STAGE_ONE_LIMIT', { infer: true });
    this.modelVersion = config.getOrThrow('SCORE_MODEL_VERSION', {
      infer: true,
    });
  }

  beforeApplicationShutdown(): void {
    this.shutdown.abort();
  }

  async process(job: Job): Promise<DiscoverySummary> {
    if (job.name !== RUN_DISCOVERY_JOB) {
      throw new UnrecoverableError(`Unknown discovery job ${job.name}`);
    }
    const parsed = parseRunDiscoveryJob(job.data);
    if (!parsed.ok) {
      throw new UnrecoverableError(parsed.reason);
    }
    const run = parsed.message;
    const stopTimer = this.metrics.discoveryRunDurationSeconds.startTimer();
    this.logger.log(
      `Discovery run ${run.runId} started with ${run.trackedAddresses.length} tracked wallets, attempt ${job.attemptsMade + 1}`,
    );
    try {
      const summary = await this.runDiscovery(job, run);
      stopTimer({ outcome: 'finished' });
      this.logger.log(
        `Discovery run ${run.runId} finished with ${summary.stageOneCount} stage-one survivors, ${summary.stageTwoCount} stage-two and ${summary.stageThreeCount} stage-three scores`,
      );
      return summary;
    } catch (error) {
      stopTimer({ outcome: 'failed' });
      this.logger.error(
        `Discovery run ${run.runId} failed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private async runDiscovery(
    job: Job,
    run: RunDiscoveryJob,
  ): Promise<DiscoverySummary> {
    const [rows, vaultAddresses] = await Promise.all([
      this.statsDataFiles.downloadLeaderboard(),
      this.statsDataFiles.downloadVaultAddresses(),
    ]);
    const plan = planStageTwo(
      rows,
      vaultAddresses,
      run.trackedAddresses,
      this.stageOneLimit,
    );
    const stageTwo = await this.scoreStageTwo(job, plan.targets);
    const preliminary = rankCohort(cohortOf(stageTwo), PRELIMINARY_COMPONENTS);
    const benchmark = computeDeflatedBenchmark(
      stageTwo.flatMap((result) =>
        result.significanceMoments === null
          ? []
          : [result.significanceMoments.sharpe],
      ),
    );
    const readDsr = (result: StageTwoResult) =>
      benchmark === null || result.significanceMoments === null
        ? null
        : computeProbabilisticSharpe(result.significanceMoments, benchmark);
    const stageThreeAddresses = selectStageThree(
      stageTwo,
      preliminary,
      this.stageThreeSize,
    );
    const stageTwoOnly = stageTwo.filter(
      (result) => !stageThreeAddresses.has(result.address),
    );
    for (const result of stageTwoOnly) {
      await this.sendScore(
        run,
        result,
        preliminary.get(result.address),
        null,
        readDsr(result),
      );
    }
    const stageThree = await this.scoreStageThree(
      job,
      stageTwo.filter((result) => stageThreeAddresses.has(result.address)),
    );
    const final = rankCohort(
      cohortOf(stageThree.filter(isStageThreeResult)),
      FINAL_COMPONENTS,
    );
    for (const result of stageThree) {
      await this.sendScore(
        run,
        result,
        preliminary.get(result.address),
        final.get(result.address) ?? null,
        readDsr(result),
      );
    }
    const summary: DiscoverySummary = {
      runId: run.runId,
      leaderboardRows: rows.length,
      stageOneCount: plan.survivorCount,
      stageTwoCount: stageTwo.length,
      stageThreeCount: stageThree.filter(isStageThreeResult).length,
      expectedScores: stageTwo.length,
    };
    await this.scoringResults.sendRunFinished({
      runId: run.runId,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      modelVersion: this.modelVersion,
      expectedScores: summary.expectedScores,
      leaderboardRows: summary.leaderboardRows,
      stageOneCount: summary.stageOneCount,
      stageTwoCount: summary.stageTwoCount,
      stageThreeCount: summary.stageThreeCount,
    });
    return summary;
  }

  private async scoreStageTwo(
    job: Job,
    targets: StageTwoTarget[],
  ): Promise<StageTwoResult[]> {
    const results: StageTwoResult[] = [];
    for (const [index, target] of targets.entries()) {
      const result = await this.scoreWithRetries(target.address, () =>
        this.scorer.scoreStageTwo(target),
      );
      if (result !== null) {
        results.push(result);
        this.metrics.discoveryWalletsScoredTotal.inc({ stage: '2' });
      }
      await this.reportProgress(job, 2, index + 1, targets.length);
    }
    return results;
  }

  private async scoreStageThree(
    job: Job,
    stageTwo: StageTwoResult[],
  ): Promise<(StageTwoResult | StageThreeResult)[]> {
    const results: (StageTwoResult | StageThreeResult)[] = [];
    for (const [index, result] of stageTwo.entries()) {
      const scored = await this.scoreWithRetries(result.address, () =>
        this.scorer.scoreStageThree(result, Date.now()),
      );
      if (scored !== null) {
        this.metrics.discoveryWalletsScoredTotal.inc({ stage: '3' });
      }
      results.push(scored ?? result);
      await this.reportProgress(job, 3, index + 1, stageTwo.length);
    }
    return results;
  }

  private async sendScore(
    run: RunDiscoveryJob,
    result: StageTwoResult | StageThreeResult,
    preliminary: RankedScore | undefined,
    final: RankedScore | null,
    dsr: number | null,
  ): Promise<void> {
    await this.scoringResults.sendWalletScore({
      runId: run.runId,
      startedAt: run.startedAt,
      modelVersion: this.modelVersion,
      score: buildScorePayload(result, {
        preliminary: preliminary?.composite ?? null,
        composite: final?.composite ?? null,
        components: (final ?? preliminary)?.components ?? null,
        dsr,
      }),
    });
  }

  private async scoreWithRetries<T>(
    address: string,
    score: () => Promise<T>,
  ): Promise<T | null> {
    for (let attempt = 1; ; attempt += 1) {
      if (this.shutdown.signal.aborted) {
        throw new Error('Discovery run interrupted by shutdown');
      }
      try {
        return await score();
      } catch (error) {
        if (error instanceof RateLimitedError) {
          this.metrics.hyperliquidRateLimitedTotal.inc({
            process: PROCESS_LABEL,
          });
        }
        if (
          attempt >= WALLET_ATTEMPTS ||
          error instanceof UnreadableResponseError
        ) {
          this.logger.warn(
            `Scoring wallet ${address} failed after ${attempt} attempts: ${describeError(error)}`,
          );
          return null;
        }
        if (!(error instanceof RateLimitedError)) {
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }
  }

  private async reportProgress(
    job: Job,
    stage: 2 | 3,
    scored: number,
    total: number,
  ): Promise<void> {
    if (scored % PROGRESS_EVERY === 0 || scored === total) {
      await job.updateProgress({ stage, scored, total });
    }
  }
}
