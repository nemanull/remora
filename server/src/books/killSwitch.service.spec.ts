import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config';
import { type CopyEvent, CopyEvents } from '../copy/copyEvents';
import type { BookView } from '../copy/types';
import { Prisma, type BookState } from '../generated/prisma/client';
import { MetricsService } from '../metrics/metrics.service';
import type { PrismaService } from '../prisma/prisma.service';
import { BookChains } from './bookChains';
import type { BookStateService } from './bookState.service';
import {
  DAILY_LOSS_REASON,
  isBelowDailyLossLimit,
  KillSwitchService,
} from './killSwitch.service';

Logger.overrideLogger(false);

function storedState(overrides: Partial<BookState> = {}): BookState {
  return {
    book: 'MAIN',
    dayStartedAt: new Date('2026-04-20T00:00:00.000Z'),
    dayStartEquity: new Prisma.Decimal(25_000),
    killSwitchActive: false,
    killSwitchReason: null,
    updatedAt: new Date('2026-04-20T00:00:00.000Z'),
    ...overrides,
  };
}

function createKillSwitch(state: BookState | null, equityUsd = '25000') {
  let row = state;
  const prisma = {
    bookState: {
      findUnique: () => Promise.resolve(row),
      findUniqueOrThrow: () => Promise.resolve(row),
      update: ({ data }: { data: Partial<BookState> }) => {
        row = { ...(row as BookState), ...data };
        return Promise.resolve(row);
      },
      upsert: ({
        create,
        update,
      }: {
        create: BookState;
        update: Partial<BookState>;
      }) => {
        const values = row === null ? create : update;
        row = {
          ...storedState(),
          ...(row ?? {}),
          ...values,
          dayStartEquity: new Prisma.Decimal(
            String(values.dayStartEquity ?? 0),
          ),
        };
        return Promise.resolve(row);
      },
    },
  } as unknown as PrismaService;
  const bookState = {
    readMainEquity: () => Promise.resolve(new Decimal(equityUsd)),
  } as unknown as BookStateService;
  const events = new CopyEvents();
  const published: CopyEvent[] = [];
  events.events$.subscribe((event) => published.push(event));
  const metrics = new MetricsService();
  const config = {
    getOrThrow: () => 0.05,
  } as unknown as ConfigService<ServerConfig, true>;
  const killSwitch = new KillSwitchService(
    prisma,
    bookState,
    new BookChains(),
    events,
    metrics,
    config,
  );
  return { killSwitch, published, metrics, readRow: () => row };
}

function mainView(equityUsd: string, dayStartEquity: string | null): BookView {
  return {
    book: 'MAIN',
    equityUsd: new Decimal(equityUsd),
    dayStartEquity:
      dayStartEquity === null ? null : new Decimal(dayStartEquity),
    freeMarginUsd: new Decimal(equityUsd),
    killSwitchActive: false,
    killSwitchReason: null,
    openCopies: [],
  };
}

describe('isBelowDailyLossLimit', () => {
  it('trips at exactly the limit below the day start', () => {
    expect(
      isBelowDailyLossLimit(new Decimal(23_750), new Decimal(25_000), 0.05),
    ).toBe(true);
  });

  it('stays off just above the limit', () => {
    expect(
      isBelowDailyLossLimit(new Decimal('23750.01'), new Decimal(25_000), 0.05),
    ).toBe(false);
  });

  it('stays off without a day start', () => {
    expect(isBelowDailyLossLimit(new Decimal(1), null, 0.05)).toBe(false);
  });
});

describe('KillSwitchService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the book state with the current equity at first boot', async () => {
    const { killSwitch, readRow } = createKillSwitch(null, '24000.5');
    await killSwitch.onModuleInit();
    expect(readRow()?.dayStartEquity.toString()).toBe('24000.5');
    await expect(killSwitch.readKillSwitch()).resolves.toEqual({
      active: false,
      reason: null,
    });
  });

  it('sets and clears the switch by hand with an event each time', async () => {
    const { killSwitch, published, metrics } = createKillSwitch(storedState());
    await killSwitch.setKillSwitch(true, 'operator pause');
    await expect(killSwitch.readKillSwitch()).resolves.toEqual({
      active: true,
      reason: 'operator pause',
    });
    await killSwitch.setKillSwitch(false, 'ignored when clearing');
    await expect(killSwitch.readKillSwitch()).resolves.toEqual({
      active: false,
      reason: null,
    });
    expect(published).toEqual([
      {
        type: 'killSwitch',
        book: 'MAIN',
        active: true,
        reason: 'operator pause',
      },
      { type: 'killSwitch', book: 'MAIN', active: false, reason: null },
    ]);
    const gauge = await metrics.killSwitchActive.get();
    expect(gauge.values[0]?.value).toBe(0);
  });

  it('trips the switch on an entry once equity is 5% below the day start', async () => {
    const { killSwitch, published } = createKillSwitch(storedState());
    const view = await killSwitch.enforceDailyLossLimit(
      mainView('23700', '25000'),
    );
    expect(view.killSwitchActive).toBe(true);
    expect(view.killSwitchReason).toContain(DAILY_LOSS_REASON);
    expect(published).toHaveLength(1);
  });

  it('leaves the view alone above the limit and in the shadow book', async () => {
    const { killSwitch, published } = createKillSwitch(storedState());
    const above = mainView('24000', '25000');
    expect(await killSwitch.enforceDailyLossLimit(above)).toBe(above);
    const shadow = { ...mainView('1', '25000'), book: 'SHADOW' as const };
    expect(await killSwitch.enforceDailyLossLimit(shadow)).toBe(shadow);
    expect(published).toHaveLength(0);
  });

  it('clears a daily loss trip when the trading day rolls', async () => {
    const { killSwitch, readRow, published } = createKillSwitch(
      storedState({
        killSwitchActive: true,
        killSwitchReason: `${DAILY_LOSS_REASON}: equity 23700.00 USD`,
      }),
      '23650',
    );
    await killSwitch.rollTradingDay(new Date('2026-04-21T00:00:01.000Z'));
    expect(readRow()).toMatchObject({
      killSwitchActive: false,
      killSwitchReason: null,
      dayStartedAt: new Date('2026-04-21T00:00:00.000Z'),
    });
    expect(readRow()?.dayStartEquity.toString()).toBe('23650');
    expect(published).toEqual([
      { type: 'killSwitch', book: 'MAIN', active: false, reason: null },
    ]);
  });

  it('keeps a manual switch through the day roll', async () => {
    const { killSwitch, readRow } = createKillSwitch(
      storedState({ killSwitchActive: true, killSwitchReason: 'maintenance' }),
    );
    await killSwitch.rollTradingDay(new Date('2026-04-21T00:00:01.000Z'));
    expect(readRow()).toMatchObject({
      killSwitchActive: true,
      killSwitchReason: 'maintenance',
    });
  });

  it('rolls a day missed while the server was down at boot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-04-23T08:30:00.000Z'));
    const { killSwitch, readRow } = createKillSwitch(storedState(), '25100');
    await killSwitch.onModuleInit();
    expect(readRow()?.dayStartedAt).toEqual(
      new Date('2026-04-23T00:00:00.000Z'),
    );
    expect(readRow()?.dayStartEquity.toString()).toBe('25100');
  });
});
