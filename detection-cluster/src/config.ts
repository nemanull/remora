import { HYPERLIQUID_URLS } from '@remora/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

function positiveInteger(fallback: number) {
  return z.coerce.number().int().positive().default(fallback);
}

export const collectorConfigSchema = z
  .object({
    CLUSTER_ID: z.coerce.number().int().positive(),
    CLUSTER_TOKEN: z.string().min(32),
    CORE_URL: z.url({ protocol: /^wss?$/ }),
    MAX_WALLETS: z.coerce.number().int().min(1).max(8).default(8),
    HYPERLIQUID_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
    HYPERLIQUID_WS_URL: z.url({ protocol: /^wss?$/ }).optional(),
    HYPERLIQUID_API_URL: z.url({ protocol: /^https?$/ }).optional(),
    HYPERLIQUID_WEIGHT_PER_MINUTE: positiveInteger(900),
    PORTFOLIO_POLL_MS: positiveInteger(600_000),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3010),
  })
  .transform((config) => ({
    ...config,
    HYPERLIQUID_WS_URL:
      config.HYPERLIQUID_WS_URL ??
      HYPERLIQUID_URLS[config.HYPERLIQUID_NETWORK].wsUrl,
    HYPERLIQUID_API_URL:
      config.HYPERLIQUID_API_URL ??
      HYPERLIQUID_URLS[config.HYPERLIQUID_NETWORK].apiUrl,
  }));

export type CollectorConfig = z.output<typeof collectorConfigSchema>;

export function validateCollectorConfig(
  environment: Record<string, unknown>,
): CollectorConfig {
  const setVariables = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== ''),
  );
  const result = collectorConfigSchema.safeParse(setVariables);
  if (!result.success) {
    throw new Error(
      `Invalid collector configuration\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function readCollectorVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
  ) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'unknown';
}
