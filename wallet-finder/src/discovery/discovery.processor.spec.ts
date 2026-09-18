import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  type GateFailure,
  RUN_DISCOVERY_JOB,
  WeightBudget,
  type WalletScoredJob,
} from '@remora/sdk';
import { type Job, UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { WalletFinderConfig } from '../config';
import { MetricsService } from '../metrics/metrics.service';
import { PRELIMINARY_COMPONENTS, rankCohort } from '../scoring/compositeScore';
import {
  type StageThreeResult,
  type StageTwoResult,
  UnreadableResponseError,
  type WalletScorer,
} from '../scoring/walletScorer';
import { DiscoveryProcessor, selectStageThree } from './discovery.processor';
import type { ScoringResults } from './scoringResults';
import type { StageTwoTarget } from './stageOne';
import type { LeaderboardRow, StatsDataFiles } from './statsDataFiles';

Logger.overrideLogger(false);

const RUN_ID = 'run-20260420T0200Z';
const STARTED_AT = '2026-04-20T02:00:00.000Z';

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

function leaderboardRow(index: number): LeaderboardRow {
  const window = { pnl: 100_000, roi: 0.1, volume: 10_000_000 };
  return {
    address: address(index),
    accountValue: 1_000_000 + index,
    windows: {
      day: window,
      week: window,
      month: { pnl: 50_000, roi: 0.05, volume: 10_000_000 },
      allTime: { pnl: 400_000, roi: 0.4, volume: 80_000_000 },
    },
  };
}

function stageTwoResult(
  target: StageTwoTarget,
  level: number,
  gateFailures: GateFailure[] = [],
): StageTwoResult {
  return {
    address: target.address,
    isTracked: target.isTracked,
    accountValueUsd: '1000000',
    historyDays: 300,
    periods: 40,
    significanceMoments: {
      periods: 40,
      mean: 0.01,
      sharpe: 0.1 + level / 100,
      skewness: 0,
      kurtosis: 3,
    },
    psr: 0.8 + level / 100,
    maxDrawdown: -0.2,
    edgeBps: 40 + level,
    sortino30d: 0.5,
    positiveShare: 0.6,
    perpPnlShare: 1,
    gateFailures,
    components: {
      significance: 0.8 + level / 100,
      drawdown: -0.2,
      edge: 40 + level,
      recency: 0.5,
      consistency: 0.6,
      copyability: null,
    },
  };
}

function stageThreeResult(stageTwo: StageTwoResult): StageThreeResult {
  return {
    ...stageTwo,
    holdMinutes: 600,
    ordersPerDay: 5,
    makerShare: 0.2,
    coreNotionalShare: 1,
    fillsWindowFrom: Date.parse(STARTED_AT) - 30 * 86_400_000,
    components: { ...stageTwo.components, copyability: Math.log(600) },
  };
}

function createProcessor(options: {
  rows: LeaderboardRow[];
  stageThreeSize: number;
  levels: Record<string, number>;
  failingStageTwo?: Record<string, GateFailure[]>;
  stageThreeErrors?: Set<string>;
}) {
  const statsDataFiles = {
    downloadLeaderboard: vi.fn().mockResolvedValue(options.rows),
    downloadVaultAddresses: vi.fn().mockResolvedValue(new Set<string>()),
  };
  const scorer = {
    scoreStageTwo: vi.fn((target: StageTwoTarget) =>
      Promise.resolve(
        stageTwoResult(
          target,
          options.levels[target.address] ?? 0,
          options.failingStageTwo?.[target.address],
        ),
      ),
    ),
    scoreStageThree: vi.fn((result: StageTwoResult) =>
      options.stageThreeErrors?.has(result.address)
        ? Promise.reject(new Error('fills unavailable'))
        : Promise.resolve(stageThreeResult(result)),
    ),
  };
  const scoringResults = {
    sendWalletScore: vi.fn().mockResolvedValue(undefined),
    sendRunFinished: vi.fn().mockResolvedValue(undefined),
  };
  const settings: Partial<Record<keyof WalletFinderConfig, number>> = {
    STAGE_THREE_SIZE: options.stageThreeSize,
    SCORE_MODEL_VERSION: 1,
  };
  const config = {
    getOrThrow: (key: keyof WalletFinderConfig) => settings[key],
    get: (key: keyof WalletFinderConfig) => settings[key],
  } as unknown as ConfigService<WalletFinderConfig, true>;
  const processor = new DiscoveryProcessor(
    statsDataFiles as unknown as StatsDataFiles,
    scorer as unknown as WalletScorer,
    scoringResults as unknown as ScoringResults,
    new MetricsService(new WeightBudget(600)),
    config,
  );
  return { processor, scorer, scoringResults };
}

function job(data: unknown, name = RUN_DISCOVERY_JOB): Job {
  return {
    name,
    data,
    attemptsMade: 0,
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job;
}

function sentScores(scoringResults: {
  sendWalletScore: ReturnType<typeof vi.fn>;
}): WalletScoredJob['score'][] {
  return scoringResults.sendWalletScore.mock.calls.map(
    ([sent]) => (sent as WalletScoredJob).score,
  );
}

describe('selectStageThree', () => {
  it('takes the best preliminary scores and every tracked wallet', () => {
    const targets = [1, 2, 3, 4].map((index) => ({
      address: address(index),
      row: null,
      isTracked: index === 1,
    }));
    const results = targets.map((target, index) =>
      stageTwoResult(target, index),
    );
    const preliminary = rankCohort(
      new Map(results.map((result) => [result.address, result.components])),
      PRELIMINARY_COMPONENTS,
    );

    expect([...selectStageThree(results, preliminary, 2)]).toEqual([
      address(4),
      address(3),
      address(1),
    ]);
  });
});

describe('DiscoveryProcessor', () => {
  const rows = [1, 2, 3, 4].map(leaderboardRow);
  const tracked = address(9);

  it('scores stage two, sends the rest as stage two, then sends stage three and the run total', async () => {
    const { processor, scoringResults, scorer } = createProcessor({
      rows,
      stageThreeSize: 2,
      levels: { [address(1)]: 1, [address(2)]: 2, [address(3)]: 3 },
      failingStageTwo: {
        [address(4)]: ['short_history'],
        [tracked]: ['not_significant'],
      },
    });

    const summary = await processor.process(
      job({
        runId: RUN_ID,
        startedAt: STARTED_AT,
        trackedAddresses: [tracked],
      }),
    );

    const scores = sentScores(scoringResults);
    const byAddress = new Map(
      scores.map((score) => [score.walletAddress, score]),
    );
    expect(scores.map((score) => score.stage)).toEqual([2, 2, 3, 3, 3]);
    expect(
      scores
        .slice(0, 2)
        .map((score) => score.walletAddress)
        .sort(),
    ).toEqual([address(1), address(4)]);
    expect(scorer.scoreStageThree).toHaveBeenCalledTimes(3);
    expect(byAddress.get(address(4))).toMatchObject({
      passed: false,
      gateFailures: ['short_history'],
      preliminary: null,
      components: null,
    });
    expect(byAddress.get(address(3))?.composite).toBeGreaterThan(
      byAddress.get(address(2))?.composite ?? 1,
    );
    expect(byAddress.get(address(3))?.components).toHaveLength(6);
    expect(byAddress.get(tracked)).toMatchObject({
      stage: 3,
      passed: false,
      composite: null,
      gateFailures: ['not_significant'],
    });
    expect(scores.every((score) => score.dsr !== null)).toBe(true);
    expect(summary).toEqual({
      runId: RUN_ID,
      leaderboardRows: 4,
      stageOneCount: 4,
      stageTwoCount: 5,
      stageThreeCount: 3,
      expectedScores: 5,
    });
    expect(scoringResults.sendRunFinished).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        startedAt: STARTED_AT,
        modelVersion: 1,
        expectedScores: 5,
        stageThreeCount: 3,
      }),
    );
  });

  it('sends a stage-two score for a wallet whose stage three failed, so the total still adds up', async () => {
    const { processor, scoringResults } = createProcessor({
      rows: rows.slice(0, 2),
      stageThreeSize: 2,
      levels: { [address(1)]: 1, [address(2)]: 2 },
      stageThreeErrors: new Set([address(2)]),
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });

    const running = processor.process(
      job({ runId: RUN_ID, startedAt: STARTED_AT, trackedAddresses: [] }),
    );
    await vi.runAllTimersAsync();
    const summary = await running;
    vi.useRealTimers();

    const scores = sentScores(scoringResults);
    expect(scores.map((score) => [score.walletAddress, score.stage])).toEqual([
      [address(2), 2],
      [address(1), 3],
    ]);
    expect(scores[0].composite).toBeNull();
    expect(scores[1].composite).toBeCloseTo(0.5, 12);
    expect(summary.expectedScores).toBe(2);
    expect(summary.stageThreeCount).toBe(1);
  });

  it('gives up at once on a wallet whose response cannot be read', async () => {
    const { processor, scorer, scoringResults } = createProcessor({
      rows: rows.slice(0, 2),
      stageThreeSize: 2,
      levels: {},
    });
    scorer.scoreStageTwo.mockImplementationOnce(() =>
      Promise.reject(
        new UnreadableResponseError(
          'portfolio',
          address(2),
          'no allTime window',
        ),
      ),
    );

    const summary = await processor.process(
      job({ runId: RUN_ID, startedAt: STARTED_AT, trackedAddresses: [] }),
    );

    expect(scorer.scoreStageTwo).toHaveBeenCalledTimes(2);
    expect(summary.stageTwoCount).toBe(1);
    expect(scoringResults.sendWalletScore).toHaveBeenCalledTimes(1);
  });

  it('refuses a job it does not know or cannot read without retrying', async () => {
    const { processor } = createProcessor({
      rows,
      stageThreeSize: 2,
      levels: {},
    });

    await expect(processor.process(job({}, 'other-job'))).rejects.toThrow(
      UnrecoverableError,
    );
    await expect(
      processor.process(job({ runId: 'run:1', startedAt: STARTED_AT })),
    ).rejects.toThrow(UnrecoverableError);
  });

  it('stops between wallets once the application shuts down', async () => {
    const { processor, scoringResults } = createProcessor({
      rows,
      stageThreeSize: 2,
      levels: {},
    });
    processor.beforeApplicationShutdown();

    await expect(
      processor.process(
        job({ runId: RUN_ID, startedAt: STARTED_AT, trackedAddresses: [] }),
      ),
    ).rejects.toThrow('Discovery run interrupted by shutdown');
    expect(scoringResults.sendRunFinished).not.toHaveBeenCalled();
  });
});
