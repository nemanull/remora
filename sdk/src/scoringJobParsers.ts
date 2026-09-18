import { z } from 'zod';
import type { ParseResult } from './clusterProtocol.js';
import type {
  RunDiscoveryJob,
  RunFinishedJob,
  ScoreComponent,
  WalletScoredJob,
  WalletScorePayload,
} from './scoringJobs.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

const runId = z.string().regex(RUN_ID_PATTERN);
const address = z.string().regex(ADDRESS_PATTERN);
const isoTime = z.iso.datetime();
const count = z.number().int().nonnegative();
const optionalNumber = z.number().nullable();

const componentSchema: z.ZodType<ScoreComponent> = z.object({
  name: z.enum([
    'significance',
    'drawdown',
    'edge',
    'recency',
    'consistency',
    'copyability',
  ]),
  raw: optionalNumber,
  winsorized: optionalNumber,
  percentile: z.number().min(0).max(1).nullable(),
  weight: z.number().nonnegative(),
  contribution: z.number(),
});

const scoreSchema: z.ZodType<WalletScorePayload> = z.object({
  walletAddress: address,
  stage: z.union([z.literal(2), z.literal(3)]),
  passed: z.boolean(),
  gateFailures: z.array(z.string().min(1)),
  preliminary: optionalNumber,
  composite: optionalNumber,
  accountValueUsd: z.string().regex(DECIMAL_PATTERN),
  historyDays: count,
  periods: count,
  psr: optionalNumber,
  dsr: optionalNumber,
  maxDrawdown: optionalNumber,
  edgeBps: optionalNumber,
  sortino30d: optionalNumber,
  positiveShare: optionalNumber,
  perpPnlShare: optionalNumber,
  holdMinutes: optionalNumber,
  ordersPerDay: optionalNumber,
  makerShare: optionalNumber,
  coreNotionalShare: optionalNumber,
  fillsWindowFrom: isoTime.nullable(),
  components: z.array(componentSchema).nullable(),
});

const runDiscoverySchema: z.ZodType<RunDiscoveryJob> = z.object({
  runId,
  startedAt: isoTime,
  trackedAddresses: z.array(address),
});

const walletScoredSchema: z.ZodType<WalletScoredJob> = z.object({
  runId,
  startedAt: isoTime,
  modelVersion: z.number().int().positive(),
  score: scoreSchema,
});

const runFinishedSchema: z.ZodType<RunFinishedJob> = z.object({
  runId,
  startedAt: isoTime,
  finishedAt: isoTime,
  modelVersion: z.number().int().positive(),
  expectedScores: count,
  leaderboardRows: count,
  stageOneCount: count,
  stageTwoCount: count,
  stageThreeCount: count,
});

function parseJob<T>(
  schema: z.ZodType<T>,
  value: unknown,
  subject: string,
): ParseResult<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  const issue = result.error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'value';
  return {
    ok: false,
    reason: `invalid ${subject} job: ${path} ${issue?.message ?? 'is invalid'}`,
  };
}

export function parseRunDiscoveryJob(
  value: unknown,
): ParseResult<RunDiscoveryJob> {
  return parseJob(runDiscoverySchema, value, 'run-discovery');
}

export function parseWalletScoredJob(
  value: unknown,
): ParseResult<WalletScoredJob> {
  return parseJob(walletScoredSchema, value, 'wallet-scored');
}

export function parseRunFinishedJob(
  value: unknown,
): ParseResult<RunFinishedJob> {
  return parseJob(runFinishedSchema, value, 'run-finished');
}
