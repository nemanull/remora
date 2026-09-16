import { Injectable, Logger } from '@nestjs/common';
import type { EventMessage, HyperliquidFill } from '@remora/sdk';
import { CopyDecisionService } from '../copy/copyDecision.service';
import {
  SignalBuilder,
  STORED_FILL_SELECT,
  type StoredFill,
} from '../copy/signalBuilder';
import type { FillSource } from '../generated/prisma/client';
import { MarketDataService } from '../market/marketData.service';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { isMainDexPerp } from './fillClassification';
import { SyncStateService } from './syncState.service';

export type UserFillsEvent = Extract<EventMessage, { channel: 'userFills' }>;

const FILL_SOURCES: Record<UserFillsEvent['source'], FillSource> = {
  stream: 'STREAM',
  snapshot: 'SNAPSHOT',
  backfill: 'BACKFILL',
};

function readFills(event: UserFillsEvent): HyperliquidFill[] {
  return event.source === 'backfill' ? event.payload : event.payload.fills;
}

function isOwnLiquidation(fill: HyperliquidFill, wallet: string): boolean {
  const liquidatedUser = fill.liquidation?.liquidatedUser;
  if (fill.liquidation === undefined) {
    return false;
  }
  return (
    liquidatedUser === undefined || liquidatedUser.toLowerCase() === wallet
  );
}

@Injectable()
export class FillIngestionService {
  private readonly logger = new Logger(FillIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
    private readonly syncState: SyncStateService,
    private readonly signalBuilder: SignalBuilder,
    private readonly copyDecision: CopyDecisionService,
    private readonly metrics: MetricsService,
  ) {}

  async ingestFills(
    sessionKey: number,
    clusterId: number,
    event: UserFillsEvent,
  ): Promise<void> {
    const fills = readFills(event);
    if (fills.length === 0) {
      return;
    }
    const markets = this.marketData.readMarkets();
    const mainDexFills = fills.filter((fill) =>
      isMainDexPerp(fill.coin, markets),
    );
    const stored = await this.storeFills(clusterId, event, mainDexFills);
    const latestFillTime = fills.reduce(
      (latest, fill) => Math.max(latest, fill.time),
      0,
    );
    this.syncState.recordFillTime(sessionKey, event.wallet, latestFillTime);
    if (event.source === 'stream') {
      this.recordFillLatency(stored, event.receivedAt);
    }
    const wallet = this.syncState.readWallet(sessionKey, event.wallet);
    if (!wallet?.isSynced) {
      this.logger.debug(
        `Stored ${stored.length} of ${fills.length} ${event.source} fills of unsynced ${event.wallet} from cluster ${clusterId}`,
      );
      return;
    }
    const signals = this.signalBuilder.buildFrameSignals(
      event.wallet,
      stored,
      event.source,
      wallet.trackedSince,
    );
    this.logger.debug(
      `Stored ${stored.length} of ${fills.length} ${event.source} fills of ${event.wallet} from cluster ${clusterId}, ${signals.length} signals`,
    );
    if (signals.length > 0) {
      this.copyDecision.routeSignals(signals);
    }
    if (event.source === 'stream') {
      await this.syncState.raiseWatermark(
        event.wallet,
        new Date(latestFillTime),
      );
    }
  }

  private async storeFills(
    clusterId: number,
    event: UserFillsEvent,
    fills: readonly HyperliquidFill[],
  ): Promise<StoredFill[]> {
    if (fills.length === 0) {
      return [];
    }
    const source = FILL_SOURCES[event.source];
    const receivedAt = new Date(event.receivedAt);
    const stored = await this.prisma.leaderFill.createManyAndReturn({
      data: fills.map((fill) => ({
        walletAddress: event.wallet,
        coin: fill.coin,
        tid: BigInt(fill.tid),
        px: fill.px,
        sz: fill.sz,
        side: fill.side,
        time: new Date(fill.time),
        startPosition: fill.startPosition,
        dir: fill.dir,
        closedPnl: fill.closedPnl,
        fee: fill.fee,
        oid: BigInt(fill.oid),
        hash: fill.hash,
        crossed: fill.crossed,
        twapId: fill.twapId === null ? null : BigInt(fill.twapId),
        isLiquidation: isOwnLiquidation(fill, event.wallet),
        source,
        clusterId,
        receivedAt,
      })),
      skipDuplicates: true,
      select: STORED_FILL_SELECT,
    });
    return stored.sort((first, second) =>
      first.id < second.id ? -1 : first.id > second.id ? 1 : 0,
    );
  }

  private recordFillLatency(
    fills: readonly StoredFill[],
    receivedAt: number,
  ): void {
    for (const fill of fills) {
      this.metrics.fillLatencyMs.observe(receivedAt - fill.time.getTime());
    }
  }
}
