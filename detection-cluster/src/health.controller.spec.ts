import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';
import type { CollectorHealth, WatchlistService } from './watchlist.service';

const WALLET = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';

function createController(health: CollectorHealth): HealthController {
  return new HealthController({ readHealth: () => health } as WatchlistService);
}

describe('HealthController', () => {
  it('answers ok when the core link is open and every assigned wallet is subscribed', () => {
    const controller = createController({
      isHealthy: true,
      coreLink: 'open',
      upstream: 'open',
      wallets: [{ address: WALLET, isSubscribed: true, backfill: 'synced' }],
    });
    expect(controller.readHealth()).toEqual({
      status: 'ok',
      coreLink: 'open',
      upstream: 'open',
      wallets: [{ address: WALLET, isSubscribed: true, backfill: 'synced' }],
    });
  });

  it('answers 503 with the same detail otherwise', () => {
    const controller = createController({
      isHealthy: false,
      coreLink: 'open',
      upstream: 'connecting',
      wallets: [{ address: WALLET, isSubscribed: false, backfill: 'pending' }],
    });
    let failure: unknown;
    try {
      controller.readHealth();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    const exception = failure as ServiceUnavailableException;
    expect(exception.getStatus()).toBe(503);
    expect(exception.getResponse()).toEqual({
      status: 'unavailable',
      coreLink: 'open',
      upstream: 'connecting',
      wallets: [{ address: WALLET, isSubscribed: false, backfill: 'pending' }],
    });
  });
});
