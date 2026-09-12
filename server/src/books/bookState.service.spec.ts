import type { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config';
import { Prisma, type CopyPosition } from '../generated/prisma/client';
import { Subject } from 'rxjs';
import type {
  Market,
  MarketDataService,
  MidsUpdate,
} from '../market/marketData.service';
import type { PrismaService } from '../prisma/prisma.service';
import { BookStateService } from './bookState.service';
import type { LiveAccountService } from './liveAccount.service';

const LEADER = '0x1111111111111111111111111111111111111111';
const OTHER_LEADER = '0x2222222222222222222222222222222222222222';

type CopyWhere = {
  book?: CopyPosition['book'];
  isOpen?: boolean;
  walletAddress?: string;
  closedAt?: { gte: Date };
};

function copy(overrides: Partial<CopyPosition>): CopyPosition {
  return {
    id: 1n,
    book: 'MAIN',
    walletAddress: LEADER,
    coin: 'ETH',
    size: new Prisma.Decimal(0),
    entryPx: null,
    ratio: new Prisma.Decimal('0.01'),
    leaderSizeAtSync: new Prisma.Decimal(100),
    allocationUsd: new Prisma.Decimal(5_000),
    stopPx: null,
    isOpen: true,
    openedAt: new Date('2026-04-20T10:00:00.000Z'),
    lastOrderAt: null,
    closedAt: null,
    closeReason: null,
    realizedPnl: new Prisma.Decimal(0),
    feesUsd: new Prisma.Decimal(0),
    fundingUsd: new Prisma.Decimal(0),
    leaderOpenTid: 1n,
    ...overrides,
  };
}

function matches(row: CopyPosition, where: CopyWhere): boolean {
  return (
    (where.book === undefined || row.book === where.book) &&
    (where.isOpen === undefined || row.isOpen === where.isOpen) &&
    (where.walletAddress === undefined ||
      row.walletAddress === where.walletAddress) &&
    (where.closedAt === undefined ||
      (row.closedAt !== null && row.closedAt >= where.closedAt.gte))
  );
}

function sum(
  rows: CopyPosition[],
  field: 'realizedPnl' | 'feesUsd' | 'fundingUsd',
) {
  return new Prisma.Decimal(
    rows
      .reduce((total, row) => total.plus(row[field].toString()), new Decimal(0))
      .toFixed(),
  );
}

function createBookState(
  rows: CopyPosition[],
  options: {
    live?: { equityUsd: string; withdrawableUsd: string };
    mids?: Subject<MidsUpdate>;
  } = {},
) {
  const prisma = {
    copyPosition: {
      findMany: ({ where }: { where: CopyWhere }) =>
        Promise.resolve(rows.filter((row) => matches(row, where))),
      findUnique: ({ where }: { where: { id: bigint } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
      aggregate: ({ where }: { where: CopyWhere }) => {
        const selected = rows.filter((row) => matches(row, where));
        return Promise.resolve({
          _sum: {
            realizedPnl: sum(selected, 'realizedPnl'),
            feesUsd: sum(selected, 'feesUsd'),
            fundingUsd: sum(selected, 'fundingUsd'),
          },
        });
      },
      groupBy: ({ where }: { where: CopyWhere }) =>
        Promise.resolve(
          [
            ...new Set(
              rows
                .filter((row) => matches(row, where))
                .map((row) => row.walletAddress),
            ),
          ].map((walletAddress) => ({ walletAddress })),
        ),
    },
    bookState: {
      findUnique: () =>
        Promise.resolve({
          book: 'MAIN',
          dayStartedAt: new Date('2026-04-20T00:00:00.000Z'),
          dayStartEquity: new Prisma.Decimal(25_100),
          killSwitchActive: true,
          killSwitchReason: 'operator pause',
          updatedAt: new Date(),
        }),
    },
  } as unknown as PrismaService;
  const markets: Record<string, Partial<Market>> = {
    ETH: { maxLeverage: 25, markPrice: new Decimal(3_050) },
    BTC: { maxLeverage: 40, markPrice: new Decimal(61_000) },
  };
  const mids: Record<string, Decimal> = { ETH: new Decimal(3_100) };
  const market = {
    mids$: options.mids?.asObservable(),
    readMarket: (coin: string) => (markets[coin] as Market) ?? null,
    readMid: (coin: string) =>
      mids[coin] === undefined
        ? null
        : { price: mids[coin], receivedAt: new Date() },
  } as unknown as MarketDataService;
  const live = options.live;
  const liveAccount = {
    isLive: () => live !== undefined,
    readAccount: () =>
      Promise.resolve({
        equityUsd: new Decimal(live?.equityUsd ?? 0),
        withdrawableUsd: new Decimal(live?.withdrawableUsd ?? 0),
        positions: [],
        time: new Date(),
      }),
  } as unknown as LiveAccountService;
  const values: Record<string, number> = {
    PAPER_EQUITY_USD: 25_000,
    SHADOW_ALLOCATION_USD: 5_000,
    MAX_EXCHANGE_LEVERAGE: 5,
  };
  const config = {
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService<ServerConfig, true>;
  return new BookStateService(prisma, market, liveAccount, config);
}

const mainCopies = [
  copy({
    id: 1n,
    size: new Prisma.Decimal('2'),
    entryPx: new Prisma.Decimal(3_000),
    feesUsd: new Prisma.Decimal('2.7'),
    fundingUsd: new Prisma.Decimal('-1.3'),
  }),
  copy({
    id: 2n,
    coin: 'BTC',
    size: new Prisma.Decimal('-0.1'),
    entryPx: new Prisma.Decimal(60_000),
    walletAddress: OTHER_LEADER,
  }),
  copy({
    id: 3n,
    isOpen: false,
    closedAt: new Date(),
    realizedPnl: new Prisma.Decimal(150),
    feesUsd: new Prisma.Decimal(5),
  }),
];

describe('BookStateService', () => {
  it('marks the paper main book at the mids and falls back to the mark price', async () => {
    const summary = await createBookState(mainCopies).readBookSummary('MAIN');
    expect(summary.unrealizedPnl.toFixed()).toBe('100');
    expect(summary.grossExposureUsd.toFixed()).toBe('12300');
    expect(summary.valueKind).toBe('equity');
    expect(summary.valueUsd.toFixed()).toBe('25241');
    expect(summary.realizedPnlToday.toFixed()).toBe('145');
    expect(summary.openPositions).toBe(2);
    expect(summary.dayStartEquity?.toFixed()).toBe('25100');
  });

  it('gives the engine every open main copy with its notional and free margin', async () => {
    const view = await createBookState(mainCopies).readBookView('MAIN', LEADER);
    expect(view.openCopies.map((open) => open.id)).toEqual([1n, 2n]);
    expect(view.openCopies[0].notionalUsd.toFixed()).toBe('6200');
    expect(view.freeMarginUsd.toFixed()).toBe('22781');
    expect(view.killSwitchActive).toBe(true);
    expect(view.killSwitchReason).toBe('operator pause');
  });

  it('measures a shadow ledger from its own allocation and copies only', async () => {
    const rows = [
      copy({
        id: 4n,
        book: 'SHADOW',
        size: new Prisma.Decimal(1),
        entryPx: new Prisma.Decimal(3_000),
      }),
      copy({
        id: 5n,
        book: 'SHADOW',
        walletAddress: OTHER_LEADER,
        isOpen: false,
        realizedPnl: new Prisma.Decimal(-40),
      }),
    ];
    const bookState = createBookState(rows);
    const view = await bookState.readBookView('SHADOW', LEADER);
    expect(view.openCopies.map((open) => open.id)).toEqual([4n]);
    expect(view.equityUsd.toFixed()).toBe('5100');
    expect(view.dayStartEquity).toBeNull();
    expect(view.killSwitchActive).toBe(false);
    const summary = await bookState.readBookSummary('SHADOW');
    expect(summary.valueKind).toBe('net_pnl');
    expect(summary.valueUsd.toFixed()).toBe('60');
    expect(summary.dayStartEquity).toBeNull();
  });

  it('keeps the shadow PnL series flat when a new leader opens its first copy', async () => {
    const rows = [
      copy({
        id: 6n,
        book: 'SHADOW',
        isOpen: false,
        realizedPnl: new Prisma.Decimal(25),
        feesUsd: new Prisma.Decimal(5),
      }),
    ];
    const bookState = createBookState(rows);
    const before = await bookState.readBookSummary('SHADOW');
    rows.push(
      copy({
        id: 7n,
        book: 'SHADOW',
        walletAddress: OTHER_LEADER,
        size: new Prisma.Decimal(0),
      }),
    );
    const after = await bookState.readBookSummary('SHADOW');
    expect(before.valueUsd.toFixed()).toBe('20');
    expect(after.valueUsd.toFixed()).toBe('20');
    const ledger = await bookState.readBookView('SHADOW', OTHER_LEADER);
    expect(ledger.equityUsd.toFixed()).toBe('5000');
  });

  it('marks a coin that left the markets at its last known mid', () => {
    const mids = new Subject<MidsUpdate>();
    const bookState = createBookState([], { mids });
    bookState.onModuleInit();
    mids.next({
      mids: new Map([['PURR', new Decimal('0.21')]]),
      receivedAt: new Date(),
    });
    expect(bookState.readMark('PURR')?.toFixed()).toBe('0.21');
    expect(bookState.readMark('DOGE')).toBeNull();
    bookState.onModuleDestroy();
  });

  it('takes live equity and free margin from the account', async () => {
    const bookState = createBookState(mainCopies, {
      live: { equityUsd: '9800.5', withdrawableUsd: '4200' },
    });
    const view = await bookState.readBookView('MAIN', LEADER);
    expect(view.equityUsd.toFixed()).toBe('9800.5');
    expect(view.freeMarginUsd.toFixed()).toBe('4200');
    await expect(bookState.readMainEquity()).resolves.toEqual(
      new Decimal('9800.5'),
    );
  });

  it('builds the market view with the mid and its time', () => {
    const bookState = createBookState([]);
    expect(bookState.readMarketView('DOGE')).toBeNull();
    expect(bookState.readMarketView('BTC')?.mid).toBeNull();
    expect(bookState.readMarketView('ETH')?.mid?.toFixed()).toBe('3100');
  });
});
