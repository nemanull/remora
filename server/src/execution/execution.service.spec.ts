import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookChains } from '../books/bookChains';
import type { BookStateService } from '../books/bookState.service';
import { CopyPositionsService } from '../books/copyPositions.service';
import type { LiveAccountService } from '../books/liveAccount.service';
import type {
  PaperStopsService,
  StopTrigger,
} from '../books/paperStops.service';
import type { ServerConfig } from '../config';
import { type CopyEvent, CopyEvents } from '../copy/copyEvents';
import type {
  BookName,
  CopyView,
  MarketView,
  NewCopy,
  OrderIntent,
} from '../copy/types';
import {
  type CopyPosition,
  type Order,
  Prisma,
} from '../generated/prisma/client';
import type { Market, MarketDataService } from '../market/marketData.service';
import type { PrismaService } from '../prisma/prisma.service';
import { cloidForOrder } from './cloid';
import { ExecutionService, MAX_EXIT_ATTEMPTS } from './execution.service';
import type { LiveExecutor, StopOrder } from './liveExecutor';
import type { NewOrder, OrdersService } from './orders.service';
import type { ExecutionResult, OrderRequest } from './types';

Logger.overrideLogger(false);

const LEADER = '0x1111111111111111111111111111111111111111';
const DECIMAL_FIELDS = [
  'size',
  'entryPx',
  'ratio',
  'leaderSizeAtSync',
  'allocationUsd',
  'stopPx',
  'realizedPnl',
  'feesUsd',
  'fundingUsd',
] as const;

const ETH_MARKET = {
  coin: 'ETH',
  assetIndex: 1,
  szDecimals: 4,
  maxLeverage: 25,
  isOnlyIsolated: false,
  marginMode: null,
  fundingRate: new Decimal(0),
  markPrice: new Decimal(3_000),
  oraclePrice: new Decimal(3_000),
} as Market;

function filled(size: string, price: string): ExecutionResult {
  return {
    status: 'FILLED',
    filledSize: new Decimal(size),
    averagePrice: new Decimal(price),
    feeUsd: new Decimal(size).mul(price).mul('0.00045'),
    exchangeOid: null,
    error: null,
    acknowledgedAt: new Date('2026-04-20T12:00:01.000Z'),
  };
}

function partial(size: string, price: string): ExecutionResult {
  return { ...filled(size, price), status: 'PARTIALLY_FILLED' };
}

function unfilled(status: ExecutionResult['status'] = 'UNFILLED') {
  return {
    status,
    filledSize: new Decimal(0),
    averagePrice: null,
    feeUsd: new Decimal(0),
    exchangeOid: null,
    error: status === 'UNFILLED' ? 'ioc_unfilled' : null,
    acknowledgedAt: status === 'UNKNOWN' ? null : new Date(),
  };
}

class FakeCopies {
  readonly rows = new Map<bigint, CopyPosition>();
  private nextId = 1n;

  insert(overrides: Partial<CopyPosition>): CopyPosition {
    const id = overrides.id ?? this.nextId++;
    const row: CopyPosition = {
      id,
      book: 'SHADOW',
      walletAddress: LEADER,
      coin: 'ETH',
      size: new Prisma.Decimal(0),
      entryPx: null,
      ratio: new Prisma.Decimal('0.01'),
      leaderSizeAtSync: new Prisma.Decimal(100),
      allocationUsd: new Prisma.Decimal(5_000),
      stopPx: null,
      isOpen: true,
      openedAt: new Date('2026-04-20T11:00:00.000Z'),
      lastOrderAt: null,
      closedAt: null,
      closeReason: null,
      realizedPnl: new Prisma.Decimal(0),
      feesUsd: new Prisma.Decimal(0),
      fundingUsd: new Prisma.Decimal(0),
      leaderOpenTid: 1n,
      ...overrides,
    };
    this.rows.set(id, row);
    return row;
  }

  readonly client = {
    create: ({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(this.insert(this.convert(data, null))),
    findUnique: ({ where }: { where: { id: bigint } }) =>
      Promise.resolve(this.rows.get(where.id) ?? null),
    findUniqueOrThrow: ({ where }: { where: { id: bigint } }) => {
      const row = this.rows.get(where.id);
      return row
        ? Promise.resolve(row)
        : Promise.reject(new Error('missing copy'));
    },
    update: ({
      where,
      data,
    }: {
      where: { id: bigint };
      data: Record<string, unknown>;
    }) => {
      const row = this.rows.get(where.id) as CopyPosition;
      const updated = { ...row, ...this.convert(data, row) };
      this.rows.set(where.id, updated);
      return Promise.resolve(updated);
    },
    delete: ({ where }: { where: { id: bigint } }) => {
      this.rows.delete(where.id);
      return Promise.resolve();
    },
  };

  private convert(
    data: Record<string, unknown>,
    row: CopyPosition | null,
  ): Partial<CopyPosition> {
    const converted: Record<string, unknown> = { ...data };
    for (const field of DECIMAL_FIELDS) {
      const value = data[field];
      if (typeof value === 'string') {
        converted[field] = new Prisma.Decimal(value);
      }
      if (typeof value === 'object' && value !== null && 'increment' in value) {
        const current = row?.[field] ?? new Prisma.Decimal(0);
        converted[field] = new Prisma.Decimal(current.toString()).plus(
          String((value as { increment: string }).increment),
        );
      }
    }
    return converted;
  }
}

class FakeOrders {
  readonly created: (NewOrder & { id: bigint; status: string })[] = [];

  createOrder(order: NewOrder): Promise<Order> {
    const row = {
      ...order,
      id: BigInt(this.created.length + 1),
      status: 'SUBMITTED',
    };
    this.created.push(row);
    return Promise.resolve(row as unknown as Order);
  }

  recordResult(order: Order, result: ExecutionResult): Promise<Order> {
    this.find(order.id).status = result.status;
    return Promise.resolve(order);
  }

  recordStatus(order: Order, status: string): Promise<Order> {
    this.find(order.id).status = status;
    return Promise.resolve(order);
  }

  readNextAttempt(positionId: bigint, purpose: string): Promise<number> {
    const attempts = this.created
      .filter(
        (order) =>
          order.positionId === positionId &&
          order.purpose === purpose &&
          order.decisionId === null,
      )
      .map((order) => order.attempt);
    return Promise.resolve(Math.max(0, ...attempts) + 1);
  }

  readRestingStops(positionId: bigint): Promise<Order[]> {
    return Promise.resolve(
      this.created.filter(
        (order) =>
          order.positionId === positionId &&
          order.purpose === 'STOP' &&
          order.status === 'SUBMITTED',
      ) as unknown as Order[],
    );
  }

  private find(id: bigint) {
    return this.created.find((order) => order.id === id) as {
      status: string;
    };
  }
}

function toView(row: CopyPosition): CopyView {
  return {
    id: row.id,
    wallet: row.walletAddress,
    coin: row.coin,
    size: new Decimal(row.size.toString()),
    ratio: new Decimal(row.ratio.toString()),
    leaderSizeAtSync: new Decimal(row.leaderSizeAtSync.toString()),
    allocationUsd: new Decimal(row.allocationUsd.toString()),
    notionalUsd: new Decimal(row.size.toString()).abs().mul(3_000),
    openedAt: row.openedAt,
    lastOrderAt: row.lastOrderAt,
  };
}

function createExecution(options: { live?: boolean } = {}) {
  const copies = new FakeCopies();
  const orders = new FakeOrders();
  const events = new CopyEvents();
  const published: CopyEvent[] = [];
  events.events$.subscribe((event) => published.push(event));
  const prisma = { copyPosition: copies.client } as unknown as PrismaService;
  const positions = new CopyPositionsService(prisma, events);
  const marketView: MarketView = {
    coin: 'ETH',
    szDecimals: 4,
    maxLeverage: 25,
    onlyIsolated: false,
    marginMode: null,
    isDelisted: false,
    mid: new Decimal(3_000),
    midAt: new Date(),
  };
  const bookState = {
    readCopyView: (id: bigint) => {
      const row = copies.rows.get(id);
      return Promise.resolve(row && row.isOpen ? toView(row) : null);
    },
    readMarketView: () => marketView,
    readMark: () => new Decimal(3_000),
  } as unknown as BookStateService;
  const triggers = new Subject<StopTrigger>();
  const tracked = new Set<bigint>();
  const paperStops = {
    triggers$: triggers.asObservable(),
    isPaperBook: (book: BookName) => book === 'SHADOW' || !options.live,
    trackStop: (copy: CopyPosition) => tracked.add(copy.id),
    untrackStop: (id: bigint) => tracked.delete(id),
  } as unknown as PaperStopsService;
  const paperResults: ExecutionResult[] = [];
  const paperRequests: OrderRequest[] = [];
  const paperExecutor = {
    execute: (request: OrderRequest) => {
      paperRequests.push(request);
      return Promise.resolve(paperResults.shift() ?? unfilled());
    },
  };
  const stopsPlaced: StopOrder[] = [];
  const cancelled: string[] = [];
  const liveExecutor = options.live
    ? ({
        execute: (request: OrderRequest) => paperExecutor.execute(request),
        placeStop: (stop: StopOrder) => {
          stopsPlaced.push(stop);
          return Promise.resolve({
            status: 'SUBMITTED',
            exchangeOid: 501n,
            error: null,
            acknowledgedAt: new Date(),
          });
        },
        cancelOrder: (_coin: string, cloid: string) => {
          cancelled.push(cloid);
          return Promise.resolve(true);
        },
        ensureLeverage: () => Promise.resolve(),
      } as unknown as LiveExecutor)
    : null;
  const liveAccount = {
    refreshAccount: vi.fn().mockResolvedValue(undefined),
  } as unknown as LiveAccountService;
  const market = {
    readMarket: (coin: string) => (coin === 'ETH' ? ETH_MARKET : null),
  } as unknown as MarketDataService;
  const values: Record<string, number> = {
    EXIT_SLIPPAGE_BPS: 300,
    STOP_LOSS_ALLOCATION_SHARE: 0.2,
    STOP_MAX_DISTANCE: 0.25,
  };
  const config = {
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService<ServerConfig, true>;
  const chains = new BookChains();
  const execution = new ExecutionService(
    chains,
    orders as unknown as OrdersService,
    positions,
    bookState,
    paperStops,
    paperExecutor as never,
    liveExecutor,
    liveAccount,
    market,
    prisma,
    events,
    config,
  );
  return {
    execution,
    copies,
    orders,
    chains,
    published,
    tracked,
    triggers,
    paperResults,
    paperRequests,
    stopsPlaced,
    cancelled,
  };
}

function entryIntent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    book: 'SHADOW',
    wallet: LEADER,
    coin: 'ETH',
    copyId: null,
    purpose: 'ENTRY',
    isBuy: true,
    size: new Decimal('1.5'),
    limitPx: new Decimal(3_030),
    reduceOnly: false,
    isExactClose: false,
    referencePx: new Decimal(3_000),
    ...overrides,
  };
}

function exitIntent(copyId: bigint, size: string): OrderIntent {
  return entryIntent({
    copyId,
    purpose: 'EXIT',
    isBuy: false,
    size: new Decimal(size),
    limitPx: new Decimal(2_910),
    reduceOnly: true,
    isExactClose: true,
  });
}

const NEW_COPY: NewCopy = {
  book: 'SHADOW',
  wallet: LEADER,
  coin: 'ETH',
  ratio: new Decimal('0.015'),
  leaderSizeAtSync: new Decimal(100),
  leaderOpenTid: 55n,
  allocationUsd: new Decimal(5_000),
  waitsForFill: true,
};

describe('ExecutionService entries', () => {
  it('creates the copy, fills it and protects it with a paper stop', async () => {
    const { execution, copies, published, tracked, paperResults } =
      createExecution();
    paperResults.push(filled('1.5', '3010'));
    await execution.executeEntry({
      intent: entryIntent(),
      decisionId: 9n,
      opensCopy: NEW_COPY,
      leaderSizeSync: null,
      decidedAt: new Date('2026-04-20T12:00:00.000Z'),
    });
    const [copy] = copies.rows.values();
    expect(copy.size.toString()).toBe('1.5');
    expect(copy.entryPx?.toString()).toBe('3010');
    expect(copy.stopPx?.toString()).toBe('2343.4');
    expect(copy.feesUsd.toString()).toBe('2.03175');
    expect(tracked.has(copy.id)).toBe(true);
    expect(published).toContainEqual(
      expect.objectContaining({ type: 'copy', change: 'opened', size: '1.5' }),
    );
  });

  it('drops the new copy when its entry fills nothing', async () => {
    const { execution, copies, published, orders } = createExecution();
    await execution.executeEntry({
      intent: entryIntent(),
      decisionId: 9n,
      opensCopy: NEW_COPY,
      leaderSizeSync: null,
      decidedAt: new Date(),
    });
    expect(copies.rows.size).toBe(0);
    expect(published.filter((event) => event.type === 'copy')).toEqual([]);
    expect(orders.created[0]).toMatchObject({
      purpose: 'ENTRY',
      attempt: 1,
      cloid: cloidForOrder({
        decisionId: 9n,
        positionId: null,
        purpose: 'ENTRY',
        attempt: 1,
      }),
    });
  });

  it('keeps a new copy at size 0 while its entry is unresolved', async () => {
    const { execution, copies, paperResults } = createExecution();
    paperResults.push(unfilled('UNKNOWN'));
    await execution.executeEntry({
      intent: entryIntent(),
      decisionId: 9n,
      opensCopy: NEW_COPY,
      leaderSizeSync: null,
      decidedAt: new Date(),
    });
    expect(
      [...copies.rows.values()].map((copy) => copy.size.toString()),
    ).toEqual(['0']);
  });

  it('moves the synced leader size only when an increase fills', async () => {
    const { execution, copies, paperResults } = createExecution();
    const copy = copies.insert({
      size: new Prisma.Decimal(1),
      entryPx: new Prisma.Decimal(3_000),
    });
    const increase = {
      intent: entryIntent({ copyId: copy.id, size: new Decimal('0.5') }),
      decisionId: 10n,
      opensCopy: null,
      leaderSizeSync: {
        copyId: copy.id,
        leaderSizeAtSync: new Decimal(150),
        waitsForFill: true,
      },
      decidedAt: new Date(),
    };
    await execution.executeEntry(increase);
    expect(copies.rows.get(copy.id)?.leaderSizeAtSync.toString()).toBe('100');
    paperResults.push(filled('0.5', '3060'));
    await execution.executeEntry({ ...increase, decisionId: 11n });
    expect(copies.rows.get(copy.id)).toMatchObject({
      leaderSizeAtSync: new Prisma.Decimal(150),
      size: new Prisma.Decimal('1.5'),
      entryPx: new Prisma.Decimal(3_020),
    });
  });
});

describe('ExecutionService exits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the copy when its exit fills the whole size', async () => {
    const { execution, copies, published, tracked, paperResults } =
      createExecution();
    const copy = copies.insert({
      size: new Prisma.Decimal('1.5'),
      entryPx: new Prisma.Decimal(3_000),
      stopPx: new Prisma.Decimal(2_400),
    });
    tracked.add(copy.id);
    paperResults.push(filled('1.5', '2990'));
    const isFlat = await execution.executeExit({
      intent: exitIntent(copy.id, '1.5'),
      decisionId: 12n,
      closeReason: 'leader_closed',
      leaderSizeSync: null,
    });
    expect(isFlat).toBe(true);
    expect(copies.rows.get(copy.id)).toMatchObject({
      isOpen: false,
      closeReason: 'leader_closed',
      stopPx: null,
    });
    expect(copies.rows.get(copy.id)?.realizedPnl.toString()).toBe('-15');
    expect(tracked.has(copy.id)).toBe(false);
    expect(published).toContainEqual(
      expect.objectContaining({ type: 'copy', change: 'closed' }),
    );
  });

  it('retries a partial exit on the chain with a new cloid until the copy is flat', async () => {
    const { execution, copies, orders, chains, paperResults, paperRequests } =
      createExecution();
    const copy = copies.insert({
      size: new Prisma.Decimal('1.5'),
      entryPx: new Prisma.Decimal(3_000),
    });
    paperResults.push(partial('1', '2995'), filled('0.5', '2990'));
    const isFlat = await execution.executeExit({
      intent: exitIntent(copy.id, '1.5'),
      decisionId: 12n,
      closeReason: 'leader_closed',
      leaderSizeSync: null,
    });
    expect(isFlat).toBe(false);
    expect(copies.rows.get(copy.id)?.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await chains.drain();
    expect(copies.rows.get(copy.id)?.isOpen).toBe(false);
    expect(orders.created.map((order) => [order.attempt, order.cloid])).toEqual(
      [1, 2].map((attempt) => [
        attempt,
        cloidForOrder({
          decisionId: 12n,
          positionId: null,
          purpose: 'EXIT',
          attempt,
        }),
      ]),
    );
    expect(paperRequests[1].size.toFixed()).toBe('0.5');
    expect(paperRequests[1].heldSize.toFixed()).toBe('0.5');
  });

  it('raises an alert after five exit attempts and leaves the rest to reconciliation', async () => {
    const { execution, copies, orders, chains, published } = createExecution();
    const copy = copies.insert({
      size: new Prisma.Decimal('1.5'),
      entryPx: new Prisma.Decimal(3_000),
    });
    await execution.executeExit({
      intent: exitIntent(copy.id, '1.5'),
      decisionId: 12n,
      closeReason: 'leader_closed',
      leaderSizeSync: null,
    });
    for (let attempt = 0; attempt < MAX_EXIT_ATTEMPTS; attempt += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
      await chains.drain();
    }
    expect(orders.created).toHaveLength(MAX_EXIT_ATTEMPTS);
    expect(published).toContainEqual(
      expect.objectContaining({
        type: 'alert',
        code: 'exit_retries_exhausted',
      }),
    );
    expect(copies.rows.get(copy.id)?.isOpen).toBe(true);
  });

  it('never retries a reduce and keeps the synced size when it fills nothing', async () => {
    const { execution, copies, orders, chains, paperResults } =
      createExecution();
    const copy = copies.insert({
      size: new Prisma.Decimal(2),
      entryPx: new Prisma.Decimal(3_000),
    });
    const reduce = {
      intent: { ...exitIntent(copy.id, '1'), isExactClose: false },
      decisionId: 13n,
      closeReason: null,
      leaderSizeSync: {
        copyId: copy.id,
        leaderSizeAtSync: new Decimal(50),
        waitsForFill: true,
      },
    };
    await execution.executeExit(reduce);
    await vi.advanceTimersByTimeAsync(60_000);
    await chains.drain();
    expect(orders.created).toHaveLength(1);
    expect(copies.rows.get(copy.id)?.leaderSizeAtSync.toString()).toBe('100');
    paperResults.push(partial('0.6', '3100'));
    await execution.executeExit({ ...reduce, decisionId: 14n });
    expect(copies.rows.get(copy.id)).toMatchObject({
      leaderSizeAtSync: new Prisma.Decimal(50),
      size: new Prisma.Decimal('1.4'),
      realizedPnl: new Prisma.Decimal(60),
      isOpen: true,
    });
  });

  it('closes a copy on a paper stop with a position cloid', async () => {
    const { execution, copies, orders, chains, triggers, paperResults } =
      createExecution();
    await execution.onModuleInit();
    const copy = copies.insert({
      size: new Prisma.Decimal('1.5'),
      entryPx: new Prisma.Decimal(3_000),
      stopPx: new Prisma.Decimal(2_400),
    });
    paperResults.push(filled('1.5', '2390'));
    triggers.next({
      book: 'SHADOW',
      wallet: LEADER,
      copyId: copy.id,
      coin: 'ETH',
      stopPx: new Decimal(2_400),
      mid: new Decimal(2_395),
    });
    await chains.drain();
    expect(copies.rows.get(copy.id)).toMatchObject({
      isOpen: false,
      closeReason: 'stop_loss',
    });
    expect(orders.created[0]).toMatchObject({
      purpose: 'STOP',
      decisionId: null,
      positionId: copy.id,
      cloid: cloidForOrder({
        decisionId: null,
        positionId: copy.id,
        purpose: 'STOP',
        attempt: 1,
      }),
    });
    execution.onModuleDestroy();
  });
});

describe('ExecutionService delisted coins', () => {
  it('settles a paper copy at the last known mid without a fee', async () => {
    const { execution, copies, orders, published, tracked } = createExecution();
    const copy = copies.insert({
      size: new Prisma.Decimal('-2'),
      entryPx: new Prisma.Decimal(3_000),
      stopPx: new Prisma.Decimal(3_600),
    });
    tracked.add(copy.id);
    await execution.settleDelistedCopy('SHADOW', copy.id, new Decimal(2_900));
    expect(copies.rows.get(copy.id)).toMatchObject({
      isOpen: false,
      closeReason: 'market_delisted',
      size: new Prisma.Decimal(0),
      realizedPnl: new Prisma.Decimal(200),
      feesUsd: new Prisma.Decimal(0),
    });
    expect(orders.created).toEqual([
      expect.objectContaining({
        purpose: 'RECONCILE',
        isBuy: true,
        status: 'FILLED',
        attempt: 1,
      }),
    ]);
    expect(tracked.has(copy.id)).toBe(false);
    expect(published).toContainEqual(
      expect.objectContaining({ type: 'copy', change: 'closed' }),
    );
  });

  it('settles at the entry price when no mid is known since boot', async () => {
    const { execution, copies } = createExecution();
    const copy = copies.insert({
      size: new Prisma.Decimal('1.5'),
      entryPx: new Prisma.Decimal(3_000),
    });
    await execution.settleDelistedCopy('SHADOW', copy.id, null);
    expect(copies.rows.get(copy.id)).toMatchObject({
      isOpen: false,
      closeReason: 'market_delisted',
      size: new Prisma.Decimal(0),
      realizedPnl: new Prisma.Decimal(0),
    });
  });
});

describe('ExecutionService live stops', () => {
  it('moves the exchange stop after an entry and cancels it when the copy closes', async () => {
    const { execution, copies, orders, paperResults, stopsPlaced, cancelled } =
      createExecution({ live: true });
    const copy = copies.insert({
      book: 'MAIN',
      size: new Prisma.Decimal(1),
      entryPx: new Prisma.Decimal(3_000),
    });
    paperResults.push(filled('1', '3000'));
    const entry = {
      intent: entryIntent({
        book: 'MAIN',
        copyId: copy.id,
        size: new Decimal(1),
      }),
      decisionId: 20n,
      opensCopy: null,
      leaderSizeSync: null,
      decidedAt: new Date(),
    };
    await execution.executeEntry(entry);
    paperResults.push(filled('1', '3000'));
    await execution.executeEntry({ ...entry, decisionId: 21n });
    expect(stopsPlaced.map((stop) => stop.triggerPx.toFixed())).toEqual([
      '2500',
      '2666.7',
    ]);
    expect(stopsPlaced[1]).toMatchObject({ isLong: true });
    expect(stopsPlaced[1].size.toFixed()).toBe('3');
    const stopOrders = orders.created.filter(
      (order) => order.purpose === 'STOP',
    );
    expect(stopOrders.map((order) => order.attempt)).toEqual([1, 2]);
    expect(cancelled).toEqual([stopOrders[0].cloid]);
    expect(stopOrders.map((order) => order.status)).toEqual([
      'UNFILLED',
      'SUBMITTED',
    ]);
    paperResults.push(filled('3', '3010'));
    await execution.executeExit({
      intent: { ...exitIntent(copy.id, '3'), book: 'MAIN' },
      decisionId: 22n,
      closeReason: 'leader_closed',
      leaderSizeSync: null,
    });
    expect(cancelled).toEqual([stopOrders[0].cloid, stopOrders[1].cloid]);
    expect(copies.rows.get(copy.id)?.isOpen).toBe(false);
  });
});
