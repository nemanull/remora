import { normalizeAddress } from '@remora/sdk';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { ReplayOptions } from './replayRun';

const DEFAULT_DAYS = 30;
const DEFAULT_ALLOCATION_USD = 5_000;
const DEFAULT_LATENCY_MS = 1_200;
const DEFAULT_DRIFT_BPS = 2;

const argumentsSchema = z.object({
  wallet: z.string().transform((value, context) => {
    const address = normalizeAddress(value);
    if (address === null) {
      context.addIssue({ code: 'custom', message: 'is not a 0x address' });
      return z.NEVER;
    }
    return address;
  }),
  days: z.coerce.number().int().min(1).max(365).default(DEFAULT_DAYS),
  allocation: z.coerce.number().positive().default(DEFAULT_ALLOCATION_USD),
  'latency-ms': z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_LATENCY_MS),
  'drift-bps': z.coerce.number().nonnegative().default(DEFAULT_DRIFT_BPS),
  end: z.iso.datetime().optional(),
});

export function parseReplayArguments(args: string[]): ReplayOptions {
  const { values } = parseArgs({
    args,
    options: {
      wallet: { type: 'string' },
      days: { type: 'string' },
      allocation: { type: 'string' },
      'latency-ms': { type: 'string' },
      'drift-bps': { type: 'string' },
      end: { type: 'string' },
    },
  });
  const result = argumentsSchema.safeParse(values);
  if (!result.success) {
    throw new Error(
      `Invalid replay arguments\n${z.prettifyError(result.error)}`,
    );
  }
  const parsed = result.data;
  return {
    wallet: parsed.wallet,
    days: parsed.days,
    allocationUsd: parsed.allocation,
    latencyMs: parsed['latency-ms'],
    driftBps: parsed['drift-bps'],
    end: parsed.end === undefined ? undefined : new Date(parsed.end),
  };
}
