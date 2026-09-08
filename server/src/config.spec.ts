import { describe, expect, it } from 'vitest';
import { validateServerConfig } from './config';

const REQUIRED = {
  DATABASE_URL: 'postgresql://remora:remora@127.0.0.1:5432/remora',
};

describe('validateServerConfig', () => {
  it('fills every default of the configuration table', () => {
    expect(validateServerConfig(REQUIRED)).toEqual({
      ...REQUIRED,
      HOST: '127.0.0.1',
      PORT: 3000,
      HYPERLIQUID_NETWORK: 'mainnet',
      HYPERLIQUID_WS_URL: 'wss://api.hyperliquid.xyz/ws',
      HYPERLIQUID_API_URL: 'https://api.hyperliquid.xyz',
      HYPERLIQUID_WEIGHT_PER_MINUTE: 400,
    });
  });

  it('points the Hyperliquid URLs at testnet on the testnet network', () => {
    const config = validateServerConfig({
      ...REQUIRED,
      HYPERLIQUID_NETWORK: 'testnet',
    });

    expect(config.HYPERLIQUID_WS_URL).toBe(
      'wss://api.hyperliquid-testnet.xyz/ws',
    );
    expect(config.HYPERLIQUID_API_URL).toBe(
      'https://api.hyperliquid-testnet.xyz',
    );
  });

  it('keeps explicit Hyperliquid URLs whatever the network', () => {
    const config = validateServerConfig({
      ...REQUIRED,
      HYPERLIQUID_NETWORK: 'testnet',
      HYPERLIQUID_WS_URL: 'ws://hyperliquid-sim:3030/ws',
      HYPERLIQUID_API_URL: 'http://hyperliquid-sim:3030',
    });

    expect(config.HYPERLIQUID_WS_URL).toBe('ws://hyperliquid-sim:3030/ws');
    expect(config.HYPERLIQUID_API_URL).toBe('http://hyperliquid-sim:3030');
  });

  it('treats empty variables as unset', () => {
    const config = validateServerConfig({
      ...REQUIRED,
      PORT: '',
    });

    expect(config.PORT).toBe(3000);
  });

  it('reads numbers from environment strings', () => {
    const config = validateServerConfig({
      ...REQUIRED,
      PORT: '3100',
      HYPERLIQUID_WEIGHT_PER_MINUTE: '300',
    });

    expect(config.PORT).toBe(3100);
    expect(config.HYPERLIQUID_WEIGHT_PER_MINUTE).toBe(300);
  });

  it.each([
    ['a missing database URL', { DATABASE_URL: undefined }, /DATABASE_URL/],
  ])('fails the boot on %s', (_, overrides, pattern) => {
    expect(() => validateServerConfig({ ...REQUIRED, ...overrides })).toThrow(
      pattern,
    );
  });
});
