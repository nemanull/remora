import { Injectable } from '@nestjs/common';
import type { CopyGapResponse } from '@remora/sdk';
import { Decimal } from 'decimal.js';
import {
  type EpisodeFill,
  type GapOrder,
  splitCopyGap,
  summarizeLeaderEpisode,
} from '../books/copyGap';
import type {
  CopyPosition,
  LeaderFill,
  Order,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { toCopyGapResponse } from './responses';

const COPY_GAP_LIMIT = 20;
const EPISODE_FILL_LIMIT = 2_000;
const BPS = 10_000;
const GAP_ORDERS = {
  orders: { include: { decision: { select: { leaderVwap: true } } } },
} as const;

type GapOrderRow = Order & {
  decision: { leaderVwap: Prisma.Decimal } | null;
};

function toDecimal(value: Prisma.Decimal): Decimal {
  return new Decimal(value.toString());
}

function readReferencePrice(order: GapOrderRow): Decimal | null {
  if (order.decision !== null) {
    return toDecimal(order.decision.leaderVwap);
  }
  if (order.avgPx === null || order.slippageBps === null) {
    return null;
  }
  const adverseShare = new Decimal(order.slippageBps).div(BPS);
  return toDecimal(order.avgPx).div(
    order.isBuy
      ? new Decimal(1).plus(adverseShare)
      : new Decimal(1).minus(adverseShare),
  );
}

function toGapOrder(order: GapOrderRow): GapOrder | null {
  const referencePrice = readReferencePrice(order);
  if (referencePrice === null) {
    return null;
  }
  return {
    purpose: order.purpose,
    isBuy: order.isBuy,
    filledSize: toDecimal(order.filledSize),
    averagePrice: order.avgPx === null ? null : toDecimal(order.avgPx),
    referencePrice,
  };
}

function toEpisodeFill(fill: LeaderFill): EpisodeFill {
  return {
    tid: fill.tid,
    isBuy: fill.side === 'B',
    size: toDecimal(fill.sz),
    startPosition: toDecimal(fill.startPosition),
    closedPnl: toDecimal(fill.closedPnl),
    fee: toDecimal(fill.fee),
  };
}

@Injectable()
export class CopyGapsService {
  constructor(private readonly prisma: PrismaService) {}

  async readCopyGaps(address: string): Promise<CopyGapResponse[]> {
    const copies = await this.prisma.copyPosition.findMany({
      where: { walletAddress: address, isOpen: false, closedAt: { not: null } },
      orderBy: { closedAt: 'desc' },
      take: COPY_GAP_LIMIT,
      include: GAP_ORDERS,
    });
    const gaps = await Promise.all(
      copies.map((copy) => this.readCopyGap(copy)),
    );
    return gaps.filter((gap) => gap !== null);
  }

  async readCopyGapsClosedBetween(
    from: Date,
    until: Date,
  ): Promise<{ gaps: CopyGapResponse[]; closedCopies: number }> {
    const copies = await this.prisma.copyPosition.findMany({
      where: { isOpen: false, closedAt: { gte: from, lte: until } },
      orderBy: { closedAt: 'asc' },
      include: GAP_ORDERS,
    });
    const gaps: CopyGapResponse[] = [];
    for (const copy of copies) {
      const gap = await this.readCopyGap(copy);
      if (gap !== null) {
        gaps.push(gap);
      }
    }
    return { gaps, closedCopies: copies.length };
  }

  private async readCopyGap(
    copy: CopyPosition & { orders: GapOrderRow[] },
  ): Promise<CopyGapResponse | null> {
    if (copy.closedAt === null) {
      return null;
    }
    const opening = await this.prisma.leaderFill.findUnique({
      where: {
        walletAddress_coin_tid: {
          walletAddress: copy.walletAddress,
          coin: copy.coin,
          tid: copy.leaderOpenTid,
        },
      },
      select: { time: true },
    });
    if (opening === null) {
      return null;
    }
    const fills = await this.prisma.leaderFill.findMany({
      where: {
        walletAddress: copy.walletAddress,
        coin: copy.coin,
        time: { gte: opening.time },
      },
      orderBy: [{ time: 'asc' }, { id: 'asc' }],
      take: EPISODE_FILL_LIMIT,
    });
    const episode = summarizeLeaderEpisode(
      fills.map(toEpisodeFill),
      copy.leaderOpenTid,
    );
    if (episode === null) {
      return null;
    }
    const gap = splitCopyGap({
      ratio: toDecimal(copy.ratio),
      realizedPnl: toDecimal(copy.realizedPnl),
      feesUsd: toDecimal(copy.feesUsd),
      fundingUsd: toDecimal(copy.fundingUsd),
      leaderClosedPnl: episode.closedPnl,
      leaderFeesUsd: episode.feesUsd,
      orders: copy.orders.map(toGapOrder).filter((order) => order !== null),
    });
    return toCopyGapResponse(
      { ...copy, closedAt: copy.closedAt },
      gap,
      episode.isClosed,
    );
  }
}
