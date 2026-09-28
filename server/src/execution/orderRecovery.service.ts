import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { CopyPositionsService } from '../books/copyPositions.service';
import type {
  CopyDecision,
  CopyPosition,
  Order,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  closeReasonFor,
  ExecutionService,
  LIVE_EXECUTOR,
} from './execution.service';
import { LiveExecutor } from './liveExecutor';
import { OrdersService } from './orders.service';
import type { ExecutionResult } from './types';

const UNRESOLVED_AT_BOOT = 'unresolved_at_boot';

type PendingOrder = Order & { decision: CopyDecision | null };

function toDecimal(value: { toString(): string }): Decimal {
  return new Decimal(value.toString());
}

function unfilledAtBoot(): ExecutionResult {
  return {
    status: 'UNFILLED',
    filledSize: new Decimal(0),
    averagePrice: null,
    feeUsd: new Decimal(0),
    exchangeOid: null,
    error: UNRESOLVED_AT_BOOT,
    acknowledgedAt: new Date(),
  };
}

export function isNewCopyEntry(order: PendingOrder): boolean {
  return (
    order.purpose === 'ENTRY' &&
    (order.decision?.action === 'OPEN' || order.decision?.action === 'FLIP')
  );
}

@Injectable()
export class OrderRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(OrderRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly positions: CopyPositionsService,
    private readonly execution: ExecutionService,
    @Inject(LIVE_EXECUTOR) private readonly liveExecutor: LiveExecutor | null,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.recoverOrders();
  }

  async recoverOrders(): Promise<void> {
    const pending = await this.prisma.order.findMany({
      where: { status: { in: ['SUBMITTED', 'UNKNOWN'] } },
      include: { decision: true },
      orderBy: { id: 'asc' },
    });
    for (const order of pending) {
      await this.recoverOrder(order);
    }
    if (this.liveExecutor !== null) {
      await this.protectLiveCopies();
    }
    this.logger.log(`Resolved ${pending.length} orders left open at boot`);
  }

  private async recoverOrder(order: PendingOrder): Promise<void> {
    const liveExecutor = order.book === 'MAIN' ? this.liveExecutor : null;
    const isLive = liveExecutor !== null;
    const result = isLive
      ? await liveExecutor.resolveOrder(
          {
            cloid: order.cloid,
            coin: order.coin,
            isBuy: order.isBuy,
            size: toDecimal(order.size),
            limitPx: toDecimal(order.limitPx),
            reduceOnly: order.reduceOnly,
            heldSize: toDecimal(order.size),
          },
          order.submittedAt,
        )
      : unfilledAtBoot();
    if (order.purpose === 'STOP' && isLive && result.status === 'UNKNOWN') {
      if (result.exchangeOid !== null && order.status !== 'SUBMITTED') {
        await this.orders.recordStatus(order, 'SUBMITTED', {
          exchangeOid: result.exchangeOid,
        });
      }
      return;
    }
    const recorded = await this.orders.recordResult(
      order,
      result,
      order.decision === null ? null : toDecimal(order.decision.leaderVwap),
    );
    this.logger.log(
      `Order ${order.cloid} ${order.purpose} on ${order.coin} resolved at boot as ${recorded.status}`,
    );
    if (order.positionId === null) {
      return;
    }
    const copy = await this.prisma.copyPosition.findUnique({
      where: { id: order.positionId },
    });
    if (copy === null || !copy.isOpen) {
      return;
    }
    await this.applyToCopy(order, copy, result);
  }

  private async applyToCopy(
    order: PendingOrder,
    copy: CopyPosition,
    result: ExecutionResult,
  ): Promise<void> {
    if (result.filledSize.lte(0) || result.averagePrice === null) {
      if (
        result.status !== 'UNKNOWN' &&
        isNewCopyEntry(order) &&
        toDecimal(copy.size).isZero()
      ) {
        await this.positions.deleteCopy(copy.id);
      }
      return;
    }
    const updated = await this.positions.applyFill(copy.id, {
      isBuy: order.isBuy,
      size: result.filledSize,
      price: result.averagePrice,
      feeUsd: result.feeUsd,
      at: result.acknowledgedAt ?? new Date(),
    });
    const syncsLeaderSize =
      order.decision !== null &&
      (order.purpose === 'ENTRY' || order.decision.action === 'REDUCE');
    if (syncsLeaderSize && order.decision !== null) {
      await this.positions.syncLeaderSize(
        copy.id,
        toDecimal(order.decision.positionAfter),
      );
    }
    if (order.reduceOnly && toDecimal(updated.size).isZero()) {
      await this.execution.closeWithoutOrder(
        copy.id,
        closeReasonFor(order.purpose, order.decision?.action ?? null),
      );
      return;
    }
    this.positions.announceChange(
      updated,
      isNewCopyEntry(order) ? 'opened' : 'resized',
    );
    if (order.purpose === 'ENTRY') {
      await this.execution.protectCopy(updated);
    }
  }

  private async protectLiveCopies(): Promise<void> {
    const copies = await this.prisma.copyPosition.findMany({
      where: {
        book: 'MAIN',
        isOpen: true,
        NOT: { size: 0 },
        orders: { none: { purpose: 'STOP', status: 'SUBMITTED' } },
      },
    });
    for (const copy of copies) {
      this.logger.warn(
        `Copy ${copy.id} on ${copy.coin} has no resting stop, placing one`,
      );
      await this.execution.protectCopy(copy);
    }
  }
}
