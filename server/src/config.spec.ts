import { describe, expect, it } from 'vitest';
import { validateServerConfig } from './config';

const REQUIRED = {
  DATABASE_URL: 'postgresql://remora:remora@127.0.0.1:5432/remora',
};
const LIVE = {
  ...REQUIRED,
  EXECUTION_MODE: 'live',
  HYPERLIQUID_ACCOUNT_ADDRESS: '0xC5fDDe670E647823dBf07A09c452FE3F33dF8677',
  HYPERLIQUID_AGENT_KEY_FILE: '/run/secrets/hyperliquid_agent_key',
};

describe('validateServerConfig', () => {
  it('fills every default of the configuration table', () => {
    expect(validateServerConfig(REQUIRED)).toEqual({
      ...REQUIRED,
      HOST: '127.0.0.1',
      PORT: 3000,
      EXECUTION_MODE: 'paper',
      HYPERLIQUID_NETWORK: 'mainnet',
      HYPERLIQUID_WS_URL: 'wss://api.hyperliquid.xyz/ws',
      HYPERLIQUID_API_URL: 'https://api.hyperliquid.xyz',
      HYPERLIQUID_WEIGHT_PER_MINUTE: 400,
      PAPER_EQUITY_USD: 25_000,
      LIVE_ALLOCATION_USD: 5_000,
      SHADOW_ALLOCATION_USD: 5_000,
      SIGNAL_MAX_AGE_MS: 15_000,
      DRIFT_LIMIT_MAJOR_BPS: 50,
      DRIFT_LIMIT_OTHER_BPS: 100,
      EXIT_SLIPPAGE_BPS: 300,
      LEADER_EQUITY_MAX_AGE_MS: 900_000,
      POSITION_CAP_MULTIPLE: 3,
      GROSS_EXPOSURE_MULTIPLE: 3,
      MAX_OPEN_COPIES: 12,
      MARGIN_BUFFER: 1.2,
      DAILY_LOSS_LIMIT: 0.05,
      STOP_LOSS_ALLOCATION_SHARE: 0.2,
      STOP_MAX_DISTANCE: 0.25,
      MAX_EXCHANGE_LEVERAGE: 5,
      ORDER_EXPIRY_MS: 5_000,
      PAPER_ORDER_LATENCY_MS: 900,
      TAKER_FEE_BPS: 4.5,
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

  it('requires the account address and the agent key file in live mode', () => {
    expect(() =>
      validateServerConfig({ ...REQUIRED, EXECUTION_MODE: 'live' }),
    ).toThrow(/HYPERLIQUID_ACCOUNT_ADDRESS[\s\S]*HYPERLIQUID_AGENT_KEY_FILE/);
  });

  it('rejects an account address that is not an address', () => {
    expect(() =>
      validateServerConfig({ ...LIVE, HYPERLIQUID_ACCOUNT_ADDRESS: '0x1234' }),
    ).toThrow(/HYPERLIQUID_ACCOUNT_ADDRESS/);
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
      TAKER_FEE_BPS: '3.5',
      HYPERLIQUID_WEIGHT_PER_MINUTE: '300',
    });

    expect(config.PORT).toBe(3100);
    expect(config.TAKER_FEE_BPS).toBe(3.5);
    expect(config.HYPERLIQUID_WEIGHT_PER_MINUTE).toBe(300);
  });

  it.each([
    ['a missing database URL', { DATABASE_URL: undefined }, /DATABASE_URL/],
    ['an unknown execution mode', { EXECUTION_MODE: 'yolo' }, /EXECUTION_MODE/],
    ['a daily loss limit of 1', { DAILY_LOSS_LIMIT: '1' }, /DAILY_LOSS_LIMIT/],
    ['a margin buffer below 1', { MARGIN_BUFFER: '0.9' }, /MARGIN_BUFFER/],
  ])('fails the boot on %s', (_, overrides, pattern) => {
    expect(() => validateServerConfig({ ...REQUIRED, ...overrides })).toThrow(
      pattern,
    );
  });
});
