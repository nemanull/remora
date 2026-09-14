import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { CopyEvents } from '../copy/copyEvents';
import type { BookName, OrderPurpose } from '../copy/types';
import type { Order } from '../generated/prisma/client';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import type { ExecutionResult } from './types';

const BASIS_POINTS = 10_000;

export type NewOrder = {
  book: BookName;
  decisionId: bigint | null;
  positionId: bigint | null;
  cloid: string;
  coin: string;
  isBuy: boolean;
  size: Decimal;
  limitPx: Decimal;
  reduceOnly: boolean;
  purpose: OrderPurpose;
  attempt: number;
  submittedAt: Date;
};

export function measureSlippageBps(
  isBuy: boolean,
  averagePrice: Decimal,
  referencePx: Decimal,
): number {
  const worseBy = isBuy
    ? averagePrice.minus(referencePx)
    : referencePx.minus(averagePrice);
  return worseBy.div(referencePx).mul(BASIS_POINTS).toNumber();
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly events: CopyEvents,
  ) {}

  createOrder(order: NewOrder): Promise<Order> {
    return this.prisma.order.create({
      data: {
        book: order.book,
        decisionId: order.decisionId,
        positionId: order.positionId,
        cloid: order.cloid,
        coin: order.coin,
        isBuy: order.isBuy,
        size: order.size.toFixed(),
        limitPx: order.limitPx.toFixed(),
        reduceOnly: order.reduceOnly,
        purpose: order.purpose,
        attempt: order.attempt,
        status: 'SUBMITTED',
        submittedAt: order.submittedAt,
      },
    });
  }

  async recordResult(
    order: Order,
    result: ExecutionResult,
    referencePx: Decimal | null,
  ): Promise<Order> {
    const slippageBps =
      result.averagePrice === null || referencePx === null
        ? null
        : measureSlippageBps(order.isBuy, result.averagePrice, referencePx);
    const recorded = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: result.status,
        filledSize: result.filledSize.toFixed(),
        avgPx: result.averagePrice?.toFixed() ?? null,
        feeUsd: result.feeUsd.toFixed(6),
        slippageBps,
        exchangeOid: result.exchangeOid,
        error: result.error,
        acknowledgedAt: result.acknowledgedAt,
      },
    });
    if (result.acknowledgedAt !== null) {
      this.metrics.orderLatencyMs.observe(
        result.acknowledgedAt.getTime() - order.submittedAt.getTime(),
      );
    }
    this.announce(recorded);
    return recorded;
  }

  async recordStatus(
    order: Order,
    status: Order['status'],
    details: {
      exchangeOid?: bigint | null;
      error?: string | null;
      acknowledgedAt?: Date | null;
    } = {},
  ): Promise<Order> {
    const recorded = await this.prisma.order.update({
      where: { id: order.id },
      data: { status, ...details },
    });
    this.announce(recorded);
    return recorded;
  }

  async correctFill(
    order: Order,
    exact: { filledSize: Decimal; averagePrice: Decimal; feeUsd: Decimal },
    referencePx: Decimal | null,
  ): Promise<Order> {
    return this.prisma.order.update({
      where: { id: order.id },
      data: {
        filledSize: exact.filledSize.toFixed(),
        avgPx: exact.averagePrice.toFixed(),
        feeUsd: exact.feeUsd.toFixed(6),
        slippageBps:
          referencePx === null
            ? order.slippageBps
            : measureSlippageBps(order.isBuy, exact.averagePrice, referencePx),
      },
    });
  }

  async readNextAttempt(
    positionId: bigint,
    purpose: OrderPurpose,
  ): Promise<number> {
    const latest = await this.prisma.order.aggregate({
      where: { positionId, purpose, decisionId: null },
      _max: { attempt: true },
    });
    return (latest._max.attempt ?? 0) + 1;
  }

  readRestingStops(positionId: bigint): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { positionId, purpose: 'STOP', status: 'SUBMITTED' },
      orderBy: { id: 'asc' },
    });
  }

  private announce(order: Order): void {
    this.events.publish({
      type: 'order',
      book: order.book,
      orderId: order.id,
      cloid: order.cloid,
      coin: order.coin,
      purpose: order.purpose,
      status: order.status,
      error: order.error,
    });
    const line = `Order ${order.id} ${order.purpose} attempt ${order.attempt} on ${order.coin} in the ${order.book} book ${order.status}, filled ${new Decimal(order.filledSize.toString()).toFixed()} of ${new Decimal(order.size.toString()).toFixed()}`;
    if (order.status !== 'REJECTED') {
      this.logger.log(line);
      return;
    }
    this.logger.warn(`${line}: ${order.error ?? 'no reason given'}`);
    this.events.publish({
      type: 'alert',
      code: 'order_rejected',
      message: `${order.purpose} order ${order.cloid} on ${order.coin} in the ${order.book} book was rejected: ${order.error ?? 'no reason given'}`,
      wallet: null,
      clusterId: null,
    });
  }
}
