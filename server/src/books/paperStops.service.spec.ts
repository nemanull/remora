import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config';
import { Prisma, type CopyPosition } from '../generated/prisma/client';
import type {
  MarketDataService,
  MidsUpdate,
} from '../market/marketData.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  isStopCrossed,
  PaperStopsService,
  type StopTrigger,
} from './paperStops.service';

Logger.overrideLogger(false);

function copy(overrides: Partial<CopyPosition> = {}): CopyPosition {
  return {
    id: 1n,
    book: 'SHADOW',
    walletAddress: '0x1111111111111111111111111111111111111111',
    coin: 'ETH',
    size: new Prisma.Decimal('1.5'),
    entryPx: new Prisma.Decimal(3_000),
    ratio: new Prisma.Decimal('0.01'),
    leaderSizeAtSync: new Prisma.Decimal(150),
    allocationUsd: new Prisma.Decimal(5_000),
    stopPx: new Prisma.Decimal(2_400),
    isOpen: true,
    openedAt: new Date('2026-04-20T10:00:00.000Z'),
    lastOrderAt: null,
    closedAt: null,
    closeReason: null,
    realizedPnl: new Prisma.Decimal(0),
    feesUsd: new Prisma.Decimal(0),
    fundingUsd: new Prisma.Decimal(0),
    leaderOpenTid: 10n,
    ...overrides,
  };
}

async function createStops(
  mode: 'paper' | 'live',
  stored: CopyPosition[] = [],
) {
  const mids = new Subject<MidsUpdate>();
  const prisma = {
    copyPosition: { findMany: () => Promise.resolve(stored) },
  } as unknown as PrismaService;
  const market = { mids$: mids.asObservable() } as MarketDataService;
  const config = {
    getOrThrow: () => mode,
  } as unknown as ConfigService<ServerConfig, true>;
  const stops = new PaperStopsService(prisma, market, config);
  const triggers: StopTrigger[] = [];
  stops.triggers$.subscribe((trigger) => triggers.push(trigger));
  await stops.onModuleInit();
  const publish = (coin: string, price: string) =>
    mids.next({
      mids: new Map([[coin, new Decimal(price)]]),
      receivedAt: new Date(),
    });
  return { stops, triggers, publish };
}

describe('isStopCrossed', () => {
  it('crosses a long stop at or below its price', () => {
    const stop = { isLong: true, stopPx: new Decimal(2_400) };
    expect(isStopCrossed(stop, new Decimal(2_401))).toBe(false);
    expect(isStopCrossed(stop, new Decimal(2_400))).toBe(true);
  });

  it('crosses a short stop at or above its price', () => {
    const stop = { isLong: false, stopPx: new Decimal(70_000) };
    expect(isStopCrossed(stop, new Decimal(69_999))).toBe(false);
    expect(isStopCrossed(stop, new Decimal(70_500))).toBe(true);
  });
});

describe('PaperStopsService', () => {
  it('triggers once when the mid crosses a stored stop', async () => {
    const { triggers, publish } = await createStops('paper', [copy()]);
    publish('ETH', '2450');
    publish('ETH', '2390');
    publish('ETH', '2300');
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ copyId: 1n, book: 'SHADOW' });
    expect(triggers[0].mid.toFixed()).toBe('2390');
  });

  it('watches a short stop added after boot', async () => {
    const { stops, triggers, publish } = await createStops('paper');
    stops.trackStop(
      copy({
        id: 2n,
        book: 'MAIN',
        coin: 'BTC',
        size: new Prisma.Decimal('-0.1'),
        stopPx: new Prisma.Decimal(70_000),
      }),
    );
    publish('BTC', '70001');
    expect(triggers.map((trigger) => trigger.copyId)).toEqual([2n]);
  });

  it('leaves main-book copies to the exchange stops in live mode', async () => {
    const { stops, triggers, publish } = await createStops('live');
    expect(stops.isPaperBook('MAIN')).toBe(false);
    stops.trackStop(copy({ id: 3n, book: 'MAIN' }));
    publish('ETH', '2000');
    expect(triggers).toHaveLength(0);
  });

  it('forgets a stop once its copy closes or loses its size', async () => {
    const { stops, triggers, publish } = await createStops('paper', [
      copy(),
      copy({ id: 4n, coin: 'SOL', stopPx: new Prisma.Decimal(100) }),
    ]);
    stops.untrackStop(1n);
    stops.trackStop(copy({ id: 4n, coin: 'SOL', size: new Prisma.Decimal(0) }));
    publish('ETH', '1000');
    publish('SOL', '50');
    expect(triggers).toHaveLength(0);
  });
});
