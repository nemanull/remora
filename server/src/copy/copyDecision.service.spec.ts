import type { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config';
import {
  buildOutOfOrderTrace,
  classifyLeaderMove,
  readCopySettingsFromConfig,
} from './copyDecision.service';
import { POLICY_ORDER } from './copyPolicies';
import type { Signal } from './types';

function signal(
  before: string,
  after: string,
  touchedZero = false,
): Pick<Signal, 'positionBefore' | 'positionAfter' | 'touchedZero'> {
  return {
    positionBefore: new Decimal(before),
    positionAfter: new Decimal(after),
    touchedZero,
  };
}

describe('classifyLeaderMove', () => {
  it.each([
    ['0', '2', false, 'OPEN'],
    ['2', '3', false, 'INCREASE'],
    ['3', '1', false, 'REDUCE'],
    ['1', '0', false, 'CLOSE'],
    ['1', '-1', false, 'FLIP'],
    ['1', '2', true, 'FLIP'],
    ['-2', '-3', false, 'INCREASE'],
  ])('reads %s to %s as %s', (before, after, touchedZero, action) => {
    expect(
      classifyLeaderMove(signal(before, after, touchedZero) as Signal),
    ).toBe(action);
  });

  it('reads no move when the position did not change', () => {
    expect(classifyLeaderMove(signal('2', '2') as Signal)).toBeNull();
  });
});

describe('buildOutOfOrderTrace', () => {
  it('rejects at the episode line and skips every other policy', () => {
    const trace = buildOutOfOrderTrace('older than the last decided fill');
    expect(trace.map((line) => line.policy)).toEqual(POLICY_ORDER);
    expect(trace.filter((line) => line.outcome === 'reject')).toEqual([
      {
        policy: 'episode',
        outcome: 'reject',
        reason: 'out_of_order',
        detail: 'older than the last decided fill',
      },
    ]);
  });
});

describe('readCopySettingsFromConfig', () => {
  it('maps the configuration onto the engine settings', () => {
    const values: Record<string, number> = {
      LIVE_ALLOCATION_USD: 5_000,
      SHADOW_ALLOCATION_USD: 2_500,
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
      MAX_EXCHANGE_LEVERAGE: 5,
    };
    const config = {
      getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService<ServerConfig, true>;
    const settings = readCopySettingsFromConfig(config);
    expect(settings.shadowAllocationUsd.toFixed()).toBe('2500');
    expect(settings).toMatchObject({
      signalMaxAgeMs: 15_000,
      maxOpenCopies: 12,
      dailyLossLimit: 0.05,
    });
  });
});
