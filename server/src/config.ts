import { HYPERLIQUID_URLS, normalizeAddress } from '@remora/sdk';
import { z } from 'zod';

function positiveInteger(fallback: number) {
  return z.coerce.number().int().positive().default(fallback);
}

const accountAddress = z.string().transform((value, context) => {
  const address = normalizeAddress(value);
  if (address === null) {
    context.addIssue({ code: 'custom', message: 'is not a 0x address' });
    return z.NEVER;
  }
  return address;
});

export const serverConfigSchema = z
  .object({
    DATABASE_URL: z.url(),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    HYPERLIQUID_NETWORK: z.enum(['mainnet', 'testnet']).default('mainnet'),
    HYPERLIQUID_WS_URL: z.url().optional(),
    HYPERLIQUID_API_URL: z.url().optional(),
    HYPERLIQUID_WEIGHT_PER_MINUTE: positiveInteger(400),
    HYPERLIQUID_ACCOUNT_ADDRESS: accountAddress.optional(),
  })
  .transform((config) => {
    const urls = HYPERLIQUID_URLS[config.HYPERLIQUID_NETWORK];
    return {
      ...config,
      HYPERLIQUID_WS_URL: config.HYPERLIQUID_WS_URL ?? urls.wsUrl,
      HYPERLIQUID_API_URL: config.HYPERLIQUID_API_URL ?? urls.apiUrl,
    };
  });

export type ServerConfig = z.output<typeof serverConfigSchema>;

export function validateServerConfig(
  environment: Record<string, unknown>,
): ServerConfig {
  const setVariables = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== ''),
  );
  const result = serverConfigSchema.safeParse(setVariables);
  if (!result.success) {
    throw new Error(
      `Invalid server configuration\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
