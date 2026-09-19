import { Logger } from '@nestjs/common';
import type { HyperliquidInfoClient } from '@remora/sdk';
import type { Job } from 'bullmq';
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { BookChains } from '../books/bookChains';
import type { BookStateService } from '../books/bookState.service';
import type { CopyPositionsService } from '../books/copyPositions.service';
import type { KillSwitchService } from '../books/killSwitch.service';
import type { LiveAccountService } from '../books/liveAccount.service';
import type { PaperStopsService } from '../books/paperStops.service';
import { type CopyEvent, CopyEvents } from '../copy/copyEvents';
import type { CopyView } from '../copy/types';
import type { ExecutionService } from '../execution/execution.service';
import { type CopyPosition, Prisma } from '../generated/prisma/client';
import type { Market, MarketDataService } from '../market/marketData.service';
import { MetricsService } from '../metrics/metrics.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MaintenanceProcessor,
  readFundingWindow,
  readLeaderPosition,
} from './maintenance.processor';

Logger.overrideLogger(false);

const LEADER = '0x1111111111111111111111111111111111111111';
const NOW = new Date('2026-04-20T12:00:30.000Z');

function copyRow(overrides: Partial<CopyPosition> = {}): CopyPosition {
  return {
    id: 7n,
    book: 'MAIN',
    walletAddress: LEADER,
    coin: 'ETH',
    size: new Prisma.Decimal('1.5'),
    entryPx: new Prisma.Decimal(3_000),
    ratio: new Prisma.Decimal('0.015'),
    leaderSizeAtSync: new Prisma.Decimal(100),
    allocationUsd: new Prisma.Decimal(5_000),
    stopPx: null,
    isOpen: true,
    openedAt: new Date('2026-04-20T08:00:00.000Z'),
    lastOrderAt: new Date('2026-04-20T09:00:00.000Z'),
    closedAt: null,
    closeReason: null,
    realizedPnl: new Prisma.Decimal(0),
    feesUsd: new Prisma.Decimal(0),
    fundingUsd: new Prisma.Decimal(0),
    leaderOpenTid: 1n,
    ...overrides,
  };
}

function view(row: CopyPosition): CopyView {
  return {
    id: row.id,
    wallet: row.walletAddress,
    coin: row.coin,
    size: new Decimal(row.size.toString()),
    ratio: new Decimal(row.ratio.toString()),
    leaderSizeAtSync: new Decimal(row.leaderSizeAtSync.toString()),
    allocationUsd: new Decimal(row.allocationUsd.toString()),
    notionalUsd: new Decimal(4_500),
    openedAt: row.openedAt,
    lastOrderAt: row.lastOrderAt,
  };
}

function createProcessor(
  options: {
    copies?: CopyPosition[];
    leaderPositions?: unknown;
    positionsAt?: Date;
    accountPositions?: { coin: string; size: string }[];
    fundingRates?: { time: number; fundingRate: string }[];
    delistedCoins?: string[];
    hasMarkets?: boolean;
    isMainBookLive?: boolean;
  } = {},
) {
  const copies = options.copies ?? [copyRow()];
  const snapshots: unknown[] = [];
  const prisma = {
    copyPosition: {
      findMany: () => Promise.resolve(copies),
      findUnique: ({ where }: { where: { id: bigint } }) =>
        Promise.resolve(copies.find((row) => row.id === where.id) ?? null),
    },
    leaderState: {
      findUnique: () =>
        Promise.resolve({
          walletAddress: LEADER,
          positions: options.leaderPositions ?? [],
          positionsAt: options.positionsAt ?? new Date(NOW.getTime() - 5_000),
        }),
    },
    bookSnapshot: {
      create: ({ data }: { data: unknown }) => {
        snapshots.push(data);
        return Promise.resolve(data);
      },
    },
    leaderFill: {
      deleteMany: vi.fn().mockResolvedValue({ count: 12 }),
    },
  } as unknown as PrismaService;
  const bookState = {
    readCopyView: (id: bigint) => {
      const row = copies.find((copy) => copy.id === id);
      return Promise.resolve(row ? view(row) : null);
    },
    readMark: () => new Decimal(3_000),
    readBookSummary: (book: string) =>
      Promise.resolve({
        book,
        valueKind: book === 'MAIN' ? 'equity' : 'net_pnl',
        valueUsd: new Decimal(book === 'MAIN' ? 25_010 : 10),
        unrealizedPnl: new Decimal(10),
        realizedPnlToday: new Decimal(0),
        grossExposureUsd: new Decimal(4_500),
        openPositions: 1,
        dayStartEquity: null,
      }),
  } as unknown as BookStateService;
  const positions = {
    adoptSize: vi.fn((id: bigint, size: Decimal) =>
      Promise.resolve(
        copyRow({ id, size: new Prisma.Decimal(size.toFixed()) }),
      ),
    ),
    announceChange: vi.fn(),
    addFunding: vi.fn().mockResolvedValue(undefined),
  };
  const execution = {
    closeCopy: vi.fn().mockResolvedValue(true),
    closeWithoutOrder: vi.fn().mockResolvedValue(undefined),
    settleDelistedCopy: vi.fn().mockResolvedValue(undefined),
  };
  const liveAccount = {
    isLive: () => options.accountPositions !== undefined,
    refreshAccount: () =>
      Promise.resolve({
        equityUsd: new Decimal(10_000),
        withdrawableUsd: new Decimal(8_000),
        positions: (options.accountPositions ?? []).map((position) => ({
          coin: position.coin,
          size: new Decimal(position.size),
          entryPx: new Decimal(3_005),
        })),
        time: NOW,
      }),
  } as unknown as LiveAccountService;
  const market = {
    hasMarkets: () => options.hasMarkets ?? true,
    readMarket: (coin: string) =>
      options.delistedCoins?.includes(coin)
        ? null
        : ({ szDecimals: 4, oraclePrice: new Decimal(3_000) } as Market),
    refreshMarkets: () => Promise.resolve(180),
  } as unknown as MarketDataService;
  const infoClient = {
    fundingHistory: vi.fn().mockResolvedValue(options.fundingRates ?? []),
  };
  const events = new CopyEvents();
  const published: CopyEvent[] = [];
  events.events$.subscribe((event) => published.push(event));
  const metrics = new MetricsService();
  const processor = new MaintenanceProcessor(
    prisma,
    new BookChains(),
    bookState,
    positions as unknown as CopyPositionsService,
    {} as KillSwitchService,
    liveAccount,
    {
      isPaperBook: (book: string) =>
        book === 'SHADOW' || options.isMainBookLive !== true,
    } as unknown as PaperStopsService,
    execution as unknown as ExecutionService,
    market,
    infoClient as unknown as HyperliquidInfoClient,
    metrics,
    events,
  );
  return {
    processor,
    prisma,
    positions,
    execution,
    infoClient,
    published,
    snapshots,
    metrics,
  };
}

describe('readLeaderPosition', () => {
  it('reads the signed size of the coin and flat when the coin is absent', () => {
    const positions = [{ coin: 'ETH', size: '-120.5' }];
    expect(readLeaderPosition(positions, 'ETH')?.toFixed()).toBe('-120.5');
    expect(readLeaderPosition(positions, 'BTC')?.toFixed()).toBe('0');
  });

  it('knows nothing without a stored position list', () => {
    expect(readLeaderPosition(null, 'ETH')).toBeNull();
  });
});

describe('readFundingWindow', () => {
  it('spans half an hour around the funding hour', () => {
    const window = readFundingWindow(new Date('2026-04-20T12:01:07.000Z'));
    expect(window.start.toISOString()).toBe('2026-04-20T11:30:00.000Z');
    expect(window.end.toISOString()).toBe('2026-04-20T12:30:00.000Z');
  });
});

describe('MaintenanceProcessor', () => {
  it('closes a copy through the book chain when its leader is flat on fresh state', async () => {
    const { processor, execution } = createProcessor();
    await expect(processor.reconcileCopies(NOW)).resolves.toEqual({
      checked: 1,
      closed: 1,
      drifting: 0,
      delisted: 0,
    });
    expect(execution.closeCopy).toHaveBeenCalledWith({
      book: 'MAIN',
      copyId: 7n,
      purpose: 'RECONCILE',
      reason: 'leader_flat',
      referencePx: null,
    });
  });

  it('holds a copy whose leader state predates its last order', async () => {
    const { processor, execution } = createProcessor({
      copies: [copyRow({ lastOrderAt: new Date(NOW.getTime() - 8_000) })],
    });
    const result = await processor.reconcileCopies(NOW);
    expect(result.closed).toBe(0);
    expect(execution.closeCopy).not.toHaveBeenCalled();
  });

  it('settles a paper copy on a delisted coin at its last known mid', async () => {
    const { processor, execution } = createProcessor({
      delistedCoins: ['ETH'],
    });
    await expect(processor.reconcileCopies(NOW)).resolves.toEqual({
      checked: 1,
      closed: 0,
      drifting: 0,
      delisted: 1,
    });
    expect(execution.settleDelistedCopy).toHaveBeenCalledWith(
      'MAIN',
      7n,
      new Decimal(3_000),
    );
    expect(execution.closeCopy).not.toHaveBeenCalled();
  });

  it('alerts once on a live copy on a delisted coin and leaves it to the operator', async () => {
    const { processor, execution, published } = createProcessor({
      delistedCoins: ['ETH'],
      isMainBookLive: true,
    });
    await processor.reconcileCopies(NOW);
    await processor.reconcileCopies(NOW);
    expect(execution.settleDelistedCopy).not.toHaveBeenCalled();
    expect(
      published.filter(
        (event) => event.type === 'alert' && event.code === 'market_delisted',
      ),
    ).toHaveLength(1);
  });

  it('never treats a coin as delisted before the markets are loaded', async () => {
    const { processor, execution } = createProcessor({
      delistedCoins: ['ETH'],
      hasMarkets: false,
    });
    const result = await processor.reconcileCopies(NOW);
    expect(result).toMatchObject({ closed: 0, delisted: 0 });
    expect(execution.settleDelistedCopy).not.toHaveBeenCalled();
  });

  it('adopts the live size only when the same difference shows twice', async () => {
    const { processor, positions, published } = createProcessor({
      accountPositions: [{ coin: 'ETH', size: '1.2' }],
    });
    await expect(processor.reconcileLiveAccount()).resolves.toEqual({
      coins: 1,
      adopted: 0,
    });
    expect(positions.adoptSize).not.toHaveBeenCalled();
    await expect(processor.reconcileLiveAccount()).resolves.toEqual({
      coins: 1,
      adopted: 1,
    });
    expect(positions.adoptSize).toHaveBeenCalledWith(
      7n,
      new Decimal('1.2'),
      new Decimal(3_005),
      expect.any(Date),
    );
    expect(published).toContainEqual(
      expect.objectContaining({ type: 'alert', code: 'live_size_adopted' }),
    );
  });

  it('alerts on a live position that no copy explains and never adopts it', async () => {
    const { processor, positions, published } = createProcessor({
      copies: [],
      accountPositions: [{ coin: 'SOL', size: '-30' }],
    });
    await processor.reconcileLiveAccount();
    await processor.reconcileLiveAccount();
    expect(positions.adoptSize).not.toHaveBeenCalled();
    expect(published).toContainEqual(
      expect.objectContaining({ type: 'alert', code: 'unknown_position' }),
    );
  });

  it('closes a copy whose live position stayed flat across two checks', async () => {
    const { processor, execution } = createProcessor({ accountPositions: [] });
    await processor.reconcileLiveAccount();
    await processor.reconcileLiveAccount();
    expect(execution.closeWithoutOrder).toHaveBeenCalledWith(
      7n,
      'exchange_flat',
    );
  });

  it('charges realized funding to paper copies open at the funding time', async () => {
    const { processor, positions, infoClient } = createProcessor({
      copies: [
        copyRow(),
        copyRow({ id: 8n, openedAt: new Date('2026-04-20T12:00:10.000Z') }),
      ],
      fundingRates: [
        { time: Date.parse('2026-04-20T12:00:00.050Z'), fundingRate: '0.0001' },
      ],
    });
    await expect(processor.accruePaperFunding(NOW)).resolves.toEqual({
      coins: 1,
      charges: 1,
    });
    expect(infoClient.fundingHistory).toHaveBeenCalledWith(
      'ETH',
      Date.parse('2026-04-20T11:30:00.000Z'),
      Date.parse('2026-04-20T12:30:00.000Z') - 1,
    );
    expect(positions.addFunding).toHaveBeenCalledWith(7n, new Decimal('-0.45'));
  });

  it('snapshots both books and prunes fills older than 90 days', async () => {
    const { processor, prisma, snapshots, metrics } = createProcessor();
    await processor.snapshotBooks(NOW);
    expect(snapshots).toEqual([
      expect.objectContaining({ book: 'MAIN', equityUsd: '25010.00' }),
      expect.objectContaining({
        book: 'SHADOW',
        equityUsd: '10.00',
        openPositions: 1,
      }),
    ]);
    const gauge = await metrics.bookEquityUsd.get();
    expect(gauge.values).toEqual([
      expect.objectContaining({ labels: { book: 'MAIN' }, value: 25_010 }),
    ]);
    await expect(processor.pruneFills(NOW)).resolves.toEqual({ deleted: 12 });
    expect(prisma.leaderFill.deleteMany).toHaveBeenCalledWith({
      where: { time: { lt: new Date('2026-01-20T12:00:30.000Z') } },
    });
  });

  it('fails an unknown job without retrying it', async () => {
    const { processor } = createProcessor();
    await expect(
      processor.process({ name: 'unknown', id: '1' } as Job),
    ).rejects.toThrow('Unknown maintenance job unknown');
  });
});
