import { Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import type { CopyPositionsService } from '../books/copyPositions.service';
import {
  type CopyDecision,
  type CopyPosition,
  type Order,
  Prisma,
} from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ExecutionService } from './execution.service';
import type { LiveExecutor } from './liveExecutor';
import type { OrdersService } from './orders.service';
import { OrderRecoveryService } from './orderRecovery.service';
import type { ExecutionResult } from './types';

Logger.overrideLogger(false);

type PendingOrder = Order & { decision: CopyDecision | null };

function decision(action: CopyDecision['action']): CopyDecision {
  return {
    id: 5n,
    book: 'MAIN',
    walletAddress: '0x1111111111111111111111111111111111111111',
    coin: 'ETH',
    signalKey: 'key',
    signalSource: 'stream',
    action,
    positionBefore: new Prisma.Decimal(100),
    positionAfter: new Prisma.Decimal(action === 'CLOSE' ? 0 : 150),
    leaderVwap: new Prisma.Decimal(3_000),
    leaderTime: new Date(),
    receivedAt: new Date(),
    decidedAt: new Date(),
    verdict: 'COPY',
    reason: 'copied',
    trace: [],
    targetSize: null,
    orderSize: null,
  };
}

function pendingOrder(overrides: Partial<PendingOrder>): PendingOrder {
  return {
    id: 1n,
    decisionId: 5n,
    positionId: 7n,
    book: 'MAIN',
    cloid: '0x0123456789abcdef0123456789abcdef',
    coin: 'ETH',
    isBuy: true,
    size: new Prisma.Decimal('1.5'),
    limitPx: new Prisma.Decimal(3_030),
    reduceOnly: false,
    purpose: 'ENTRY',
    attempt: 1,
    status: 'SUBMITTED',
    filledSize: new Prisma.Decimal(0),
    avgPx: null,
    feeUsd: new Prisma.Decimal(0),
    slippageBps: null,
    exchangeOid: null,
    error: null,
    submittedAt: new Date('2026-04-20T12:00:00.000Z'),
    acknowledgedAt: null,
    decision: decision('OPEN'),
    ...overrides,
  };
}

function copy(size: string): CopyPosition {
  return {
    id: 7n,
    book: 'MAIN',
    walletAddress: '0x1111111111111111111111111111111111111111',
    coin: 'ETH',
    size: new Prisma.Decimal(size),
    entryPx: size === '0' ? null : new Prisma.Decimal(3_000),
    ratio: new Prisma.Decimal('0.015'),
    leaderSizeAtSync: new Prisma.Decimal(100),
    allocationUsd: new Prisma.Decimal(5_000),
    stopPx: null,
    isOpen: true,
    openedAt: new Date(),
    lastOrderAt: null,
    closedAt: null,
    closeReason: null,
    realizedPnl: new Prisma.Decimal(0),
    feesUsd: new Prisma.Decimal(0),
    fundingUsd: new Prisma.Decimal(0),
    leaderOpenTid: 1n,
  };
}

function result(
  status: ExecutionResult['status'],
  size = '0',
): ExecutionResult {
  return {
    status,
    filledSize: new Decimal(size),
    averagePrice: size === '0' ? null : new Decimal(3_010),
    feeUsd: new Decimal(0),
    exchangeOid: status === 'UNKNOWN' ? 600n : null,
    error: null,
    acknowledgedAt: new Date(),
  };
}

function createRecovery(
  pending: PendingOrder[],
  stored: CopyPosition,
  resolved: ExecutionResult | null,
) {
  const prisma = {
    order: { findMany: () => Promise.resolve(pending) },
    copyPosition: {
      findUnique: () => Promise.resolve(stored),
      findMany: () => Promise.resolve([]),
    },
  } as unknown as PrismaService;
  const orders = {
    recordResult: vi.fn((order: Order, outcome: ExecutionResult) =>
      Promise.resolve({ ...order, status: outcome.status }),
    ),
    recordStatus: vi.fn(),
  };
  const filledCopy = copy('1.5');
  const positions = {
    applyFill: vi.fn((_: bigint, fill: { isBuy: boolean; size: Decimal }) =>
      Promise.resolve(
        copy(
          new Decimal(stored.size.toString())
            .plus(fill.isBuy ? fill.size : fill.size.neg())
            .toFixed(),
        ),
      ),
    ),
    deleteCopy: vi.fn().mockResolvedValue(undefined),
    syncLeaderSize: vi.fn().mockResolvedValue(undefined),
    announceChange: vi.fn(),
  };
  const execution = {
    closeWithoutOrder: vi.fn().mockResolvedValue(undefined),
    protectCopy: vi.fn().mockResolvedValue(undefined),
  };
  const liveExecutor =
    resolved === null
      ? null
      : { resolveOrder: vi.fn().mockResolvedValue(resolved) };
  const recovery = new OrderRecoveryService(
    prisma,
    orders as unknown as OrdersService,
    positions as unknown as CopyPositionsService,
    execution as unknown as ExecutionService,
    liveExecutor as unknown as LiveExecutor | null,
  );
  return { recovery, orders, positions, execution, liveExecutor, filledCopy };
}

describe('OrderRecoveryService in paper mode', () => {
  it('marks an open order unfilled and drops the copy its entry created', async () => {
    const { recovery, orders, positions } = createRecovery(
      [pendingOrder({})],
      copy('0'),
      null,
    );
    await recovery.onModuleInit();
    expect(orders.recordResult.mock.calls[0][1]).toMatchObject({
      status: 'UNFILLED',
      error: 'unresolved_at_boot',
    });
    expect(positions.deleteCopy).toHaveBeenCalledWith(7n);
  });

  it('keeps a deferred copy whose increase was left open', async () => {
    const { recovery, positions } = createRecovery(
      [pendingOrder({ decision: decision('INCREASE') })],
      copy('0'),
      null,
    );
    await recovery.recoverOrders();
    expect(positions.deleteCopy).not.toHaveBeenCalled();
  });
});

describe('OrderRecoveryService in live mode', () => {
  it('applies an exit that filled while the server was down and closes the copy', async () => {
    const { recovery, positions, execution, liveExecutor } = createRecovery(
      [
        pendingOrder({
          purpose: 'EXIT',
          isBuy: false,
          reduceOnly: true,
          decision: decision('CLOSE'),
        }),
      ],
      copy('1.5'),
      result('FILLED', '1.5'),
    );
    await recovery.recoverOrders();
    expect(liveExecutor?.resolveOrder).toHaveBeenCalledWith(
      expect.objectContaining({ cloid: '0x0123456789abcdef0123456789abcdef' }),
      new Date('2026-04-20T12:00:00.000Z'),
    );
    expect(positions.applyFill).toHaveBeenCalled();
    expect(execution.closeWithoutOrder).toHaveBeenCalledWith(
      7n,
      'leader_closed',
    );
  });

  it('applies an increase that filled, syncs the leader size and moves the stop', async () => {
    const { recovery, positions, execution } = createRecovery(
      [pendingOrder({ decision: decision('INCREASE') })],
      copy('1'),
      result('FILLED', '0.5'),
    );
    await recovery.recoverOrders();
    expect(positions.syncLeaderSize).toHaveBeenCalledWith(7n, new Decimal(150));
    expect(positions.announceChange).toHaveBeenCalledWith(
      expect.anything(),
      'resized',
    );
    expect(execution.protectCopy).toHaveBeenCalled();
  });

  it('leaves a resting exchange stop untouched', async () => {
    const { recovery, orders, positions } = createRecovery(
      [
        pendingOrder({
          purpose: 'STOP',
          decisionId: null,
          decision: null,
          reduceOnly: true,
          isBuy: false,
        }),
      ],
      copy('1.5'),
      result('UNKNOWN'),
    );
    await recovery.recoverOrders();
    expect(orders.recordResult).not.toHaveBeenCalled();
    expect(orders.recordStatus).not.toHaveBeenCalled();
    expect(positions.applyFill).not.toHaveBeenCalled();
  });

  it('marks shadow orders unfilled without asking the exchange', async () => {
    const { recovery, orders, liveExecutor } = createRecovery(
      [pendingOrder({ book: 'SHADOW' })],
      { ...copy('0'), book: 'SHADOW' },
      result('FILLED', '1.5'),
    );
    await recovery.recoverOrders();
    expect(liveExecutor?.resolveOrder).not.toHaveBeenCalled();
    expect(orders.recordResult.mock.calls[0][1].status).toBe('UNFILLED');
  });
});
