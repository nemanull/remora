import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { BookChains } from '../books/bookChains';
import type { CopyPositionsService } from '../books/copyPositions.service';
import type { ServerConfig } from '../config';
import { type CopyEvent, CopyEvents } from '../copy/copyEvents';
import { type Order, Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  AccountStreamService,
  summarizeOrderFills,
} from './accountStream.service';
import type { ExecutionService } from './execution.service';

Logger.overrideLogger(false);

const ACCOUNT = '0x3333333333333333333333333333333333333333';

function storedOrder(overrides: Partial<Order>): Order {
  return {
    id: 1n,
    decisionId: 5n,
    positionId: 7n,
    book: 'MAIN',
    cloid: '0x0123456789abcdef0123456789abcdef',
    coin: 'ETH',
    isBuy: true,
    size: new Prisma.Decimal(1),
    limitPx: new Prisma.Decimal(3_030),
    reduceOnly: false,
    purpose: 'ENTRY',
    attempt: 1,
    status: 'FILLED',
    filledSize: new Prisma.Decimal(1),
    avgPx: new Prisma.Decimal(3_000),
    feeUsd: new Prisma.Decimal('1.35'),
    slippageBps: null,
    exchangeOid: 900n,
    error: null,
    submittedAt: new Date(),
    acknowledgedAt: new Date(),
    ...overrides,
  };
}

function accountFill(
  tid: number,
  oid: number,
  size: string,
  fee: string,
  cloid: string | null,
) {
  return {
    coin: 'ETH',
    px: '3000',
    sz: size,
    side: 'B' as const,
    time: Date.parse('2026-04-20T12:00:00.000Z'),
    oid,
    tid,
    fee,
    cloid,
  };
}

function frame(fills: ReturnType<typeof accountFill>[], isSnapshot = false) {
  return {
    channel: 'userFills' as const,
    data: { ...(isSnapshot ? { isSnapshot: true } : {}), user: ACCOUNT, fills },
  };
}

function createStream(orders: Order[], copySize = '0') {
  const chains = new BookChains();
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    order: {
      findFirst: ({ where }: { where: Record<string, unknown> }) => {
        const cloid = (where.OR as { cloid?: string }[] | undefined)?.[0]
          ?.cloid;
        return Promise.resolve(
          orders.find(
            (order) =>
              order.cloid === cloid ||
              order.exchangeOid ===
                ((where.exchangeOid as bigint | undefined) ??
                  (where.OR as { exchangeOid?: bigint }[] | undefined)?.[1]
                    ?.exchangeOid),
          ) ?? null,
        );
      },
      update: ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return Promise.resolve(data);
      },
    },
    copyDecision: { findUnique: () => Promise.resolve(null) },
  } as unknown as PrismaService;
  const positions = {
    adjustFees: vi.fn().mockResolvedValue(undefined),
    applyFill: vi.fn().mockResolvedValue({
      id: 7n,
      size: new Prisma.Decimal(copySize),
    }),
    announceChange: vi.fn(),
  };
  const execution = {
    closeWithoutOrder: vi.fn().mockResolvedValue(undefined),
  };
  const events = new CopyEvents();
  const published: CopyEvent[] = [];
  events.events$.subscribe((event) => published.push(event));
  const stream = new AccountStreamService(
    prisma,
    chains,
    positions as unknown as CopyPositionsService,
    execution as unknown as ExecutionService,
    events,
    null,
    {} as ConfigService<ServerConfig, true>,
  );
  return { stream, chains, updates, positions, execution, published };
}

describe('summarizeOrderFills', () => {
  it('sums the size and fees and weights the price', () => {
    const summary = summarizeOrderFills([
      { ...accountFill(1, 9, '1', '0.5', null), px: '100' },
      { ...accountFill(2, 9, '3', '1.5', null), px: '200' },
    ]);
    expect(summary?.filledSize.toFixed()).toBe('4');
    expect(summary?.averagePrice.toFixed()).toBe('175');
    expect(summary?.feeUsd.toFixed()).toBe('2');
  });
});

describe('AccountStreamService', () => {
  it('replaces the estimated fee with the exact fees once every fill arrived', async () => {
    const order = storedOrder({});
    const { stream, chains, updates, positions } = createStream([order]);
    stream.handleFrame(frame([accountFill(1, 900, '0.4', '0.5', order.cloid)]));
    await chains.drain();
    expect(positions.adjustFees).not.toHaveBeenCalled();
    stream.handleFrame(
      frame([
        accountFill(1, 900, '0.4', '0.5', order.cloid),
        accountFill(2, 900, '0.6', '0.75', order.cloid),
      ]),
    );
    await chains.drain();
    expect(positions.adjustFees).toHaveBeenCalledWith(7n, new Decimal('-0.1'));
    expect(updates.at(-1)).toMatchObject({ feeUsd: '1.250000' });
  });

  it('applies a triggered exchange stop to its copy and closes it', async () => {
    const stop = storedOrder({
      id: 2n,
      decisionId: null,
      purpose: 'STOP',
      status: 'SUBMITTED',
      isBuy: false,
      reduceOnly: true,
      filledSize: new Prisma.Decimal(0),
      feeUsd: new Prisma.Decimal(0),
      avgPx: null,
      exchangeOid: 501n,
    });
    const { stream, chains, positions, execution, updates } = createStream(
      [stop],
      '0',
    );
    stream.handleFrame(frame([accountFill(3, 501, '1', '1.3', stop.cloid)]));
    await chains.drain();
    expect(positions.applyFill).toHaveBeenCalledWith(
      7n,
      expect.objectContaining({ isBuy: false, size: new Decimal(1) }),
    );
    expect(updates[0]).toMatchObject({ status: 'FILLED', filledSize: '1' });
    expect(execution.closeWithoutOrder).toHaveBeenCalledWith(7n, 'stop_loss');
  });

  it('alerts on a live fill that matches no order, but not on a snapshot', async () => {
    const { stream, chains, published } = createStream([]);
    stream.handleFrame(frame([accountFill(4, 77, '2', '1', null)], true));
    await chains.drain();
    expect(published).toHaveLength(0);
    stream.handleFrame(frame([accountFill(5, 78, '2', '1', null)]));
    await chains.drain();
    expect(published).toEqual([
      expect.objectContaining({ type: 'alert', code: 'unknown_account_fill' }),
    ]);
  });

  it('counts a fill delivered twice once', async () => {
    const order = storedOrder({});
    const { stream, chains, positions } = createStream([order]);
    const fill = accountFill(6, 900, '1', '1.2', order.cloid);
    stream.handleFrame(frame([fill]));
    await chains.drain();
    stream.handleFrame(frame([fill]));
    await chains.drain();
    expect(positions.adjustFees).toHaveBeenCalledTimes(1);
    expect(positions.applyFill).not.toHaveBeenCalled();
  });
});
