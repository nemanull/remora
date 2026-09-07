import { describe, expect, it } from 'vitest';
import { readCollectorVersion, validateCollectorConfig } from './config';

const REQUIRED = {
  CLUSTER_ID: '2',
  CLUSTER_TOKEN: 'collector-token-0123456789abcdef0123456789',
  CORE_URL: 'wss://core.example.com/cluster',
};

describe('validateCollectorConfig', () => {
  it('fills the defaults of the configuration table', () => {
    expect(validateCollectorConfig(REQUIRED)).toEqual({
      CLUSTER_ID: 2,
      CLUSTER_TOKEN: REQUIRED.CLUSTER_TOKEN,
      CORE_URL: REQUIRED.CORE_URL,
      MAX_WALLETS: 8,
      HYPERLIQUID_NETWORK: 'mainnet',
      HYPERLIQUID_WS_URL: 'wss://api.hyperliquid.xyz/ws',
      HYPERLIQUID_API_URL: 'https://api.hyperliquid.xyz',
      HYPERLIQUID_WEIGHT_PER_MINUTE: 900,
      PORTFOLIO_POLL_MS: 600_000,
      HOST: '127.0.0.1',
      PORT: 3010,
    });
  });

  it('derives the testnet URLs unless they are set', () => {
    expect(
      validateCollectorConfig({ ...REQUIRED, HYPERLIQUID_NETWORK: 'testnet' }),
    ).toMatchObject({
      HYPERLIQUID_WS_URL: 'wss://api.hyperliquid-testnet.xyz/ws',
      HYPERLIQUID_API_URL: 'https://api.hyperliquid-testnet.xyz',
    });
    expect(
      validateCollectorConfig({
        ...REQUIRED,
        HYPERLIQUID_WS_URL: 'ws://hyperliquid-sim:3030/ws',
        HYPERLIQUID_API_URL: 'http://hyperliquid-sim:3030',
      }),
    ).toMatchObject({
      HYPERLIQUID_WS_URL: 'ws://hyperliquid-sim:3030/ws',
      HYPERLIQUID_API_URL: 'http://hyperliquid-sim:3030',
    });
  });

  it('rejects a missing token, a short token, more than 8 wallets and a non-socket core URL', () => {
    expect(() =>
      validateCollectorConfig({ ...REQUIRED, CLUSTER_TOKEN: '' }),
    ).toThrow('CLUSTER_TOKEN');
    expect(() =>
      validateCollectorConfig({ ...REQUIRED, CLUSTER_TOKEN: 'short' }),
    ).toThrow('CLUSTER_TOKEN');
    expect(() =>
      validateCollectorConfig({ ...REQUIRED, MAX_WALLETS: '9' }),
    ).toThrow('MAX_WALLETS');
    expect(() =>
      validateCollectorConfig({
        ...REQUIRED,
        CORE_URL: 'https://core.example.com',
      }),
    ).toThrow('CORE_URL');
    expect(() =>
      validateCollectorConfig({ ...REQUIRED, CLUSTER_ID: '0' }),
    ).toThrow('CLUSTER_ID');
  });

  it('reads the collector version from its package', () => {
    expect(readCollectorVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
