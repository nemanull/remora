import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { Prisma } from '../generated/prisma/client';
import {
  summarizeFills,
  type ClassifiedFill,
} from '../ingestion/fillClassification';
import { PrismaService } from '../prisma/prisma.service';
import type { Signal, SignalSource } from './types';

export const STORED_FILL_SELECT = {
  id: true,
  coin: true,
  tid: true,
  px: true,
  sz: true,
  side: true,
  time: true,
  startPosition: true,
  receivedAt: true,
} satisfies Prisma.LeaderFillSelect;

export type StoredFill = Prisma.LeaderFillGetPayload<{
  select: typeof STORED_FILL_SELECT;
}>;

export type SignalFill = ClassifiedFill & {
  id: bigint;
  coin: string;
  receivedAt: Date;
};

export function toSignalFill(fill: StoredFill): SignalFill {
  return {
    id: fill.id,
    coin: fill.coin,
    tid: fill.tid,
    price: new Decimal(fill.px.toString()),
    size: new Decimal(fill.sz.toString()),
    isBuy: fill.side === 'B',
    startPosition: new Decimal(fill.startPosition.toString()),
    time: fill.time,
    receivedAt: fill.receivedAt,
  };
}

export function buildCoinSignal(
  wallet: string,
  coin: string,
  fills: readonly SignalFill[],
  source: SignalSource,
): Signal {
  const summary = summarizeFills(fills);
  const first = fills[0];
  const last = fills[fills.length - 1];
  return {
    key: `${wallet}-${coin}-${first.tid}`,
    wallet,
    coin,
    source,
    fillIds: fills.map((fill) => fill.id),
    firstTid: first.tid,
    episodeOpenTid: summary.episodeOpenTid,
    positionBefore: summary.positionBefore,
    positionAfter: summary.positionAfter,
    touchedZero: summary.touchedZero,
    vwap: summary.vwap,
    lastFillTime: summary.lastTime,
    receivedAt: last.receivedAt,
  };
}

export function buildSignals(
  wallet: string,
  fills: readonly SignalFill[],
  source: SignalSource,
  trackedSince: Date,
): Signal[] {
  const fillsByCoin = new Map<string, SignalFill[]>();
  for (const fill of fills) {
    if (fill.time < trackedSince) {
      continue;
    }
    const coinFills = fillsByCoin.get(fill.coin);
    if (coinFills) {
      coinFills.push(fill);
    } else {
      fillsByCoin.set(fill.coin, [fill]);
    }
  }
  return [...fillsByCoin].map(([coin, coinFills]) =>
    buildCoinSignal(wallet, coin, coinFills, source),
  );
}

@Injectable()
export class SignalBuilder {
  constructor(private readonly prisma: PrismaService) {}

  buildFrameSignals(
    wallet: string,
    fills: readonly StoredFill[],
    source: Exclude<SignalSource, 'catch_up'>,
    trackedSince: Date,
  ): Signal[] {
    return buildSignals(wallet, fills.map(toSignalFill), source, trackedSince);
  }

  async buildCatchUp(wallet: string, trackedSince: Date): Promise<Signal[]> {
    const fills = await this.prisma.leaderFill.findMany({
      where: {
        walletAddress: wallet,
        signalledAt: null,
        time: { gte: trackedSince },
      },
      orderBy: [{ time: 'asc' }, { id: 'asc' }],
      select: STORED_FILL_SELECT,
    });
    return buildSignals(
      wallet,
      fills.map(toSignalFill),
      'catch_up',
      trackedSince,
    );
  }
}
