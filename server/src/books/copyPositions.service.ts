import { Injectable, Logger } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { CopyEvents } from '../copy/copyEvents';
import type { NewCopy } from '../copy/types';
import type { CopyPosition, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { applyFill, type PositionFill } from './positionFills';

export type CopyFill = PositionFill & {
  feeUsd: Decimal;
  at: Date;
};

export type CopyChange = 'opened' | 'resized' | 'closed';

function toDecimal(value: { toString(): string }): Decimal {
  return new Decimal(value.toString());
}

@Injectable()
export class CopyPositionsService {
  private readonly logger = new Logger(CopyPositionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: CopyEvents,
  ) {}

  createCopy(
    copy: NewCopy,
    openedAt: Date,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<CopyPosition> {
    return client.copyPosition.create({
      data: {
        book: copy.book,
        walletAddress: copy.wallet,
        coin: copy.coin,
        size: '0',
        ratio: copy.ratio.toFixed(),
        leaderSizeAtSync: copy.leaderSizeAtSync.toFixed(),
        allocationUsd: copy.allocationUsd.toFixed(2),
        openedAt,
        leaderOpenTid: copy.leaderOpenTid,
      },
    });
  }

  async deleteCopy(copyId: bigint): Promise<void> {
    await this.prisma.copyPosition.delete({ where: { id: copyId } });
  }

  async applyFill(copyId: bigint, fill: CopyFill): Promise<CopyPosition> {
    const copy = await this.prisma.copyPosition.findUniqueOrThrow({
      where: { id: copyId },
    });
    const ledger = applyFill(
      {
        size: toDecimal(copy.size),
        entryPx: copy.entryPx === null ? null : toDecimal(copy.entryPx),
        realizedPnl: toDecimal(copy.realizedPnl),
      },
      fill,
    );
    return this.prisma.copyPosition.update({
      where: { id: copyId },
      data: {
        size: ledger.size.toFixed(),
        entryPx: ledger.entryPx?.toFixed() ?? null,
        realizedPnl: ledger.realizedPnl.toFixed(6),
        feesUsd: { increment: fill.feeUsd.toFixed(6) },
        lastOrderAt: fill.at,
      },
    });
  }

  async adjustFees(copyId: bigint, deltaUsd: Decimal): Promise<void> {
    if (deltaUsd.isZero()) {
      return;
    }
    await this.prisma.copyPosition.update({
      where: { id: copyId },
      data: { feesUsd: { increment: deltaUsd.toFixed(6) } },
    });
  }

  async closeCopy(
    copyId: bigint,
    reason: string,
    at: Date,
  ): Promise<CopyPosition> {
    const copy = await this.prisma.copyPosition.update({
      where: { id: copyId },
      data: { isOpen: false, closedAt: at, closeReason: reason, stopPx: null },
    });
    this.logger.log(
      `Copy ${copy.id} of ${copy.walletAddress} on ${copy.coin} in the ${copy.book} book closed, ${reason}, realized ${toDecimal(copy.realizedPnl).toFixed(2)} USD`,
    );
    this.announceChange(copy, 'closed');
    return copy;
  }

  async syncLeaderSize(copyId: bigint, leaderSize: Decimal): Promise<void> {
    await this.prisma.copyPosition.update({
      where: { id: copyId },
      data: { leaderSizeAtSync: leaderSize.toFixed() },
    });
  }

  setStopPrice(copyId: bigint, stopPx: Decimal | null): Promise<CopyPosition> {
    return this.prisma.copyPosition.update({
      where: { id: copyId },
      data: { stopPx: stopPx?.toFixed() ?? null },
    });
  }

  async addFunding(copyId: bigint, amountUsd: Decimal): Promise<void> {
    await this.prisma.copyPosition.update({
      where: { id: copyId },
      data: { fundingUsd: { increment: amountUsd.toFixed(6) } },
    });
  }

  adoptSize(
    copyId: bigint,
    size: Decimal,
    entryPx: Decimal | null,
    at: Date,
  ): Promise<CopyPosition> {
    return this.prisma.copyPosition.update({
      where: { id: copyId },
      data: {
        size: size.toFixed(),
        entryPx: entryPx?.toFixed() ?? null,
        lastOrderAt: at,
      },
    });
  }

  announceChange(copy: CopyPosition, change: CopyChange): void {
    this.events.publish({
      type: 'copy',
      book: copy.book,
      positionId: copy.id,
      wallet: copy.walletAddress,
      coin: copy.coin,
      change,
      size: toDecimal(copy.size).toFixed(),
      realizedPnl: toDecimal(copy.realizedPnl).toFixed(),
    });
  }
}
