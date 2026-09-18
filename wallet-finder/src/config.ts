import { HYPERLIQUID_URLS, STATS_DATA_URL } from '@remora/sdk';
import { z } from 'zod';

function positiveInteger(fallback: number) {
  return z.coerce.number().int().positive().default(fallback);
}

export const walletFinderConfigSchema = z.object({
  REDIS_URL: z.url(),
  HYPERLIQUID_API_URL: z.url().default(HYPERLIQUID_URLS.mainnet.apiUrl),
  STATS_DATA_URL: z.url().default(STATS_DATA_URL),
  HYPERLIQUID_WEIGHT_PER_MINUTE: positiveInteger(600),
  STAGE_THREE_SIZE: positiveInteger(100),
  STAGE_THREE_MAX_PAGES: z.coerce.number().int().min(1).max(5).default(3),
  STAGE_ONE_LIMIT: z.coerce.number().int().positive().optional(),
  SCORE_MODEL_VERSION: positiveInteger(1),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3020),
});

export type WalletFinderConfig = z.output<typeof walletFinderConfigSchema>;

export function validateWalletFinderConfig(
  environment: Record<string, unknown>,
): WalletFinderConfig {
  const setVariables = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== ''),
  );
  const result = walletFinderConfigSchema.safeParse(setVariables);
  if (!result.success) {
    throw new Error(
      `Invalid wallet-finder configuration\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
