import { describe, expect, it } from 'vitest';
import type { ParseResult } from './clusterProtocol.js';
import {
  parseRunDiscoveryJob,
  parseRunFinishedJob,
  parseWalletScoredJob,
} from './scoringJobParsers.js';
import type { WalletScorePayload } from './scoringJobs.js';

const WALLET = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';
const STARTED_AT = '2026-04-20T02:00:00.000Z';

function score(
  overrides: Partial<WalletScorePayload> = {},
): WalletScorePayload {
  return {
    walletAddress: WALLET,
    stage: 3,
    passed: true,
    gateFailures: [],
    preliminary: 0.71,
    composite: 0.64,
    accountValueUsd: '1029082.25',
    historyDays: 259,
    periods: 37,
    psr: 0.813,
    dsr: 0.12,
    maxDrawdown: -0.384,
    edgeBps: 59.7,
    sortino30d: 0.4,
    positiveShare: 0.62,
    perpPnlShare: 0.504,
    holdMinutes: 1289,
    ordersPerDay: 7.2,
    makerShare: 0.734,
    coreNotionalShare: 1,
    fillsWindowFrom: '2026-03-21T02:00:00.000Z',
    components: [
      {
        name: 'significance',
        raw: 0.813,
        winsorized: 0.813,
        percentile: 0.5,
        weight: 0.3,
        contribution: 0.15,
      },
    ],
    ...overrides,
  };
}

function expectFailure(result: ParseResult<unknown>): string {
  if (result.ok) {
    throw new Error('expected the job to be rejected');
  }
  return result.reason;
}

describe('parseRunDiscoveryJob', () => {
  it('accepts a run with tracked addresses', () => {
    const job = {
      runId: 'run-20260420T0200Z',
      startedAt: STARTED_AT,
      trackedAddresses: [WALLET],
    };

    expect(parseRunDiscoveryJob(job)).toEqual({ ok: true, message: job });
  });

  it('rejects a run id with a colon, which BullMQ refuses as a job id', () => {
    const reason = expectFailure(
      parseRunDiscoveryJob({
        runId: 'run:20260420',
        startedAt: STARTED_AT,
        trackedAddresses: [],
      }),
    );

    expect(reason).toContain('runId');
  });

  it('rejects an address that is not lowercase', () => {
    const reason = expectFailure(
      parseRunDiscoveryJob({
        runId: 'run-20260420T0200Z',
        startedAt: STARTED_AT,
        trackedAddresses: [WALLET.toUpperCase().replace('0X', '0x')],
      }),
    );

    expect(reason).toContain('trackedAddresses.0');
  });
});

describe('parseWalletScoredJob', () => {
  it('accepts a full stage-three score', () => {
    const job = {
      runId: 'run-20260420T0200Z',
      startedAt: STARTED_AT,
      modelVersion: 1,
      score: score(),
    };

    expect(parseWalletScoredJob(job)).toEqual({ ok: true, message: job });
  });

  it('accepts a stage-two score without behaviour metrics', () => {
    const result = parseWalletScoredJob({
      runId: 'run-20260420T0200Z',
      startedAt: STARTED_AT,
      modelVersion: 1,
      score: score({
        stage: 2,
        composite: null,
        holdMinutes: null,
        ordersPerDay: null,
        makerShare: null,
        coreNotionalShare: null,
        fillsWindowFrom: null,
        components: null,
      }),
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a stage that does not exist', () => {
    const reason = expectFailure(
      parseWalletScoredJob({
        runId: 'run-20260420T0200Z',
        startedAt: STARTED_AT,
        modelVersion: 1,
        score: { ...score(), stage: 1 },
      }),
    );

    expect(reason).toContain('score.stage');
  });

  it('rejects an account value that is not a decimal string', () => {
    const reason = expectFailure(
      parseWalletScoredJob({
        runId: 'run-20260420T0200Z',
        startedAt: STARTED_AT,
        modelVersion: 1,
        score: score({ accountValueUsd: 'NaN' }),
      }),
    );

    expect(reason).toContain('score.accountValueUsd');
  });
});

describe('parseRunFinishedJob', () => {
  it('accepts the counts of a finished run', () => {
    const job = {
      runId: 'run-20260420T0200Z',
      startedAt: STARTED_AT,
      finishedAt: '2026-04-20T03:41:12.000Z',
      modelVersion: 1,
      expectedScores: 1_629,
      leaderboardRows: 46_934,
      stageOneCount: 1_629,
      stageTwoCount: 1_629,
      stageThreeCount: 104,
    };

    expect(parseRunFinishedJob(job)).toEqual({ ok: true, message: job });
  });

  it('rejects a negative count', () => {
    const reason = expectFailure(
      parseRunFinishedJob({
        runId: 'run-20260420T0200Z',
        startedAt: STARTED_AT,
        finishedAt: STARTED_AT,
        modelVersion: 1,
        expectedScores: -1,
        leaderboardRows: 0,
        stageOneCount: 0,
        stageTwoCount: 0,
        stageThreeCount: 0,
      }),
    );

    expect(reason).toContain('expectedScores');
  });
});
