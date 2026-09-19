import { HyperliquidInfoClient } from '@remora/sdk';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { Decimal } from 'decimal.js';
import { BookChains } from '../books/bookChains';
import { BookStateService } from '../books/bookState.service';
import { reconcileCopy } from '../books/copyReconciliation';
import { CopyPositionsService } from '../books/copyPositions.service';
import { KillSwitchService } from '../books/killSwitch.service';
import { LiveAccountService } from '../books/liveAccount.service';
import { fundingPayment } from '../books/paperFunding';
import { PaperStopsService } from '../books/paperStops.service';
import { CopyEvents } from '../copy/copyEvents';
import type { BookName, CopyView } from '../copy/types';
import {
  ExecutionService,
  MARKET_DELISTED,
} from '../execution/execution.service';
import type { CopyPosition } from '../generated/prisma/client';
import type { LeaderPosition } from '../ingestion/leaderState.service';
import { MarketDataService } from '../market/marketData.service';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACCRUE_PAPER_FUNDING_JOB,
  MAINTENANCE_QUEUE,
  PRUNE_FILLS_JOB,
  RECONCILE_COPIES_JOB,
  RECONCILE_LIVE_ACCOUNT_JOB,
  REFRESH_MARKETS_JOB,
  ROLL_TRADING_DAY_JOB,
  SNAPSHOT_BOOKS_JOB,
} from './queues';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const FILL_RETENTION_DAYS = 90;
const BOOKS: BookName[] = ['MAIN', 'SHADOW'];

type AccountDifference = {
  copySize: string;
  exchangeSize: string;
};

export type CopiesReconciled = {
  checked: number;
  closed: number;
  drifting: number;
  delisted: number;
};

type CopyCheck = 'close' | 'drift' | 'hold' | 'delisted';

export function readLeaderPosition(
  positions: unknown,
  coin: string,
): Decimal | null {
  if (!Array.isArray(positions)) {
    return null;
  }
  const position = (positions as LeaderPosition[]).find(
    (entry) => entry.coin === coin,
  );
  return position === undefined ? new Decimal(0) : new Decimal(position.size);
}

export function readFundingWindow(now: Date): { start: Date; end: Date } {
  const hour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  return {
    start: new Date(hour - HOUR_MS / 2),
    end: new Date(hour + HOUR_MS / 2),
  };
}

function toDecimal(value: { toString(): string }): Decimal {
  return new Decimal(value.toString());
}

@Processor(MAINTENANCE_QUEUE, { concurrency: 1, autorun: false })
export class MaintenanceProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(MaintenanceProcessor.name);
  private readonly accountDifferences = new Map<string, AccountDifference>();
  private readonly delistedAlerts = new Set<bigint>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly chains: BookChains,
    private readonly bookState: BookStateService,
    private readonly positions: CopyPositionsService,
    private readonly killSwitch: KillSwitchService,
    private readonly liveAccount: LiveAccountService,
    private readonly paperStops: PaperStopsService,
    private readonly execution: ExecutionService,
    private readonly market: MarketDataService,
    private readonly infoClient: HyperliquidInfoClient,
    private readonly metrics: MetricsService,
    private readonly events: CopyEvents,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker
      .run()
      .catch((error) =>
        this.logger.error(
          'The maintenance worker stopped',
          error instanceof Error ? error.stack : String(error),
        ),
      );
  }

  async process(job: Job): Promise<unknown> {
    this.logger.log(`Job ${job.name} ${job.id ?? ''} started`);
    try {
      const result = await this.handle(job);
      this.logger.log(
        `Job ${job.name} ${job.id ?? ''} finished: ${JSON.stringify(result)}`,
      );
      return result;
    } catch (error) {
      this.logger.error(
        `Job ${job.name} ${job.id ?? ''} failed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private handle(job: Job): Promise<unknown> {
    const now = new Date();
    switch (job.name) {
      case RECONCILE_COPIES_JOB:
        return this.reconcileCopies(now);
      case RECONCILE_LIVE_ACCOUNT_JOB:
        return this.reconcileLiveAccount();
      case SNAPSHOT_BOOKS_JOB:
        return this.snapshotBooks(now);
      case ACCRUE_PAPER_FUNDING_JOB:
        return this.accruePaperFunding(now);
      case REFRESH_MARKETS_JOB:
        return this.refreshMarkets();
      case ROLL_TRADING_DAY_JOB:
        return this.killSwitch.rollTradingDay(now).then(() => ({
          day: now.toISOString().slice(0, 10),
        }));
      case PRUNE_FILLS_JOB:
        return this.pruneFills(now);
      default:
        throw new UnrecoverableError(`Unknown maintenance job ${job.name}`);
    }
  }

  async reconcileCopies(now: Date): Promise<CopiesReconciled> {
    const copies = await this.prisma.copyPosition.findMany({
      where: { isOpen: true },
      select: { id: true, book: true, walletAddress: true },
      orderBy: { id: 'asc' },
    });
    const outcomes = await Promise.all(
      copies.map((copy) =>
        this.chains.run(copy.book, copy.walletAddress, () =>
          this.reconcileOpenCopy(copy.id, copy.book, now),
        ),
      ),
    );
    return {
      checked: copies.length,
      closed: outcomes.filter((outcome) => outcome === 'close').length,
      drifting: outcomes.filter((outcome) => outcome === 'drift').length,
      delisted: outcomes.filter((outcome) => outcome === 'delisted').length,
    };
  }

  private async reconcileOpenCopy(
    copyId: bigint,
    book: BookName,
    now: Date,
  ): Promise<CopyCheck> {
    const copy = await this.bookState.readCopyView(copyId);
    if (copy === null) {
      return 'hold';
    }
    const market = this.market.readMarket(copy.coin);
    if (market === null && this.market.hasMarkets()) {
      await this.handleDelistedCopy(copy, book);
      return 'delisted';
    }
    const mid = this.bookState.readMark(copy.coin);
    if (market === null || mid === null) {
      return 'hold';
    }
    const state = await this.prisma.leaderState.findUnique({
      where: { walletAddress: copy.wallet },
    });
    const outcome = reconcileCopy({
      copy,
      leaderPosition: readLeaderPosition(state?.positions ?? null, copy.coin),
      leaderPositionsAt: state?.positionsAt ?? null,
      mid,
      szDecimals: market.szDecimals,
      now,
    });
    if (outcome.outcome === 'close') {
      this.logger.log(
        `Reconciliation closes copy ${copy.id} of ${copy.wallet} on ${copy.coin} in the ${book} book: ${outcome.detail}`,
      );
      await this.execution.closeCopy({
        book,
        copyId: copy.id,
        purpose: 'RECONCILE',
        reason: outcome.reason,
        referencePx: null,
      });
    }
    if (outcome.outcome === 'drift') {
      this.logger.warn(
        `Copy ${copy.id} of ${copy.wallet} on ${copy.coin} in the ${book} book drifts: ${outcome.detail}`,
      );
    }
    return outcome.outcome;
  }

  private async handleDelistedCopy(
    copy: CopyView,
    book: BookName,
  ): Promise<void> {
    if (!this.paperStops.isPaperBook(book)) {
      if (!this.delistedAlerts.has(copy.id)) {
        this.delistedAlerts.add(copy.id);
        this.alert(
          MARKET_DELISTED,
          `Copy ${copy.id} of ${copy.wallet} holds ${copy.size.toFixed()} ${copy.coin}, which left the live markets, and the exchange settles it`,
        );
      }
      return;
    }
    const lastMid = this.bookState.readMark(copy.coin);
    this.logger.warn(
      lastMid === null
        ? `Copy ${copy.id} on ${copy.coin} in the ${book} book closes as ${MARKET_DELISTED} at its entry price, because no mid of ${copy.coin} is known since boot`
        : `Copy ${copy.id} on ${copy.coin} in the ${book} book closes as ${MARKET_DELISTED} at the last known mid ${lastMid.toFixed()}`,
    );
    await this.execution.settleDelistedCopy(book, copy.id, lastMid);
  }

  async reconcileLiveAccount(): Promise<{ coins: number; adopted: number }> {
    if (!this.liveAccount.isLive()) {
      return { coins: 0, adopted: 0 };
    }
    return this.chains.run('MAIN', '', async () => {
      const account = await this.liveAccount.refreshAccount();
      const copies = await this.prisma.copyPosition.findMany({
        where: { book: 'MAIN', isOpen: true },
        orderBy: { id: 'asc' },
      });
      const exchangeSizes = new Map(
        account.positions.map((position) => [position.coin, position]),
      );
      const coins = new Set([
        ...exchangeSizes.keys(),
        ...copies.map((copy) => copy.coin),
      ]);
      let adopted = 0;
      for (const coin of coins) {
        const coinCopies = copies.filter((copy) => copy.coin === coin);
        const exchange = exchangeSizes.get(coin);
        const isAdopted = await this.compareAccountCoin(
          coin,
          coinCopies,
          exchange?.size ?? new Decimal(0),
          exchange?.entryPx ?? null,
        );
        adopted += isAdopted ? 1 : 0;
      }
      return { coins: coins.size, adopted };
    });
  }

  private async compareAccountCoin(
    coin: string,
    copies: CopyPosition[],
    exchangeSize: Decimal,
    exchangeEntryPx: Decimal | null,
  ): Promise<boolean> {
    const copySize = copies.reduce(
      (total, copy) => total.plus(copy.size.toString()),
      new Decimal(0),
    );
    if (copySize.equals(exchangeSize)) {
      this.accountDifferences.delete(coin);
      return false;
    }
    const difference = {
      copySize: copySize.toFixed(),
      exchangeSize: exchangeSize.toFixed(),
    };
    const previous = this.accountDifferences.get(coin);
    this.accountDifferences.set(coin, difference);
    if (
      previous === undefined ||
      previous.copySize !== difference.copySize ||
      previous.exchangeSize !== difference.exchangeSize
    ) {
      this.logger.warn(
        `Live account holds ${difference.exchangeSize} ${coin} where the MAIN copies hold ${difference.copySize}, checking again in a minute`,
      );
      return false;
    }
    const sized = copies.filter((copy) => !toDecimal(copy.size).isZero());
    const target =
      sized.length === 1
        ? sized[0]
        : sized.length === 0 && copies.length === 1
          ? copies[0]
          : undefined;
    if (target === undefined) {
      this.alert(
        'unknown_position',
        copies.length === 0
          ? `Live account holds ${difference.exchangeSize} ${coin} that no MAIN copy explains`
          : `Live account holds ${difference.exchangeSize} ${coin} across ${copies.length} MAIN copies, which cannot be matched`,
      );
      return false;
    }
    this.accountDifferences.delete(coin);
    if (exchangeSize.isZero()) {
      await this.execution.closeWithoutOrder(target.id, 'exchange_flat');
    } else {
      const copy = await this.positions.adoptSize(
        target.id,
        exchangeSize,
        exchangeEntryPx,
        new Date(),
      );
      this.positions.announceChange(copy, 'resized');
    }
    this.alert(
      'live_size_adopted',
      `Copy ${target.id} on ${coin} adopted the live account's ${difference.exchangeSize} in place of ${difference.copySize}`,
    );
    return true;
  }

  async snapshotBooks(now: Date): Promise<{ books: number }> {
    for (const book of BOOKS) {
      const summary = await this.bookState.readBookSummary(book);
      await this.prisma.bookSnapshot.create({
        data: {
          book,
          takenAt: now,
          equityUsd: summary.valueUsd.toFixed(2),
          unrealizedPnl: summary.unrealizedPnl.toFixed(2),
          realizedPnlToday: summary.realizedPnlToday.toFixed(2),
          grossExposureUsd: summary.grossExposureUsd.toFixed(2),
          openPositions: summary.openPositions,
        },
      });
      if (summary.valueKind === 'equity') {
        this.metrics.bookEquityUsd.set({ book }, summary.valueUsd.toNumber());
      }
    }
    return { books: BOOKS.length };
  }

  async accruePaperFunding(
    now: Date,
  ): Promise<{ coins: number; charges: number }> {
    const window = readFundingWindow(now);
    const copies = await this.prisma.copyPosition.findMany({
      where: { isOpen: true, NOT: { size: 0 } },
      orderBy: { id: 'asc' },
    });
    const paperCopies = copies.filter((copy) =>
      this.paperStops.isPaperBook(copy.book),
    );
    const coins = [...new Set(paperCopies.map((copy) => copy.coin))];
    let charges = 0;
    for (const coin of coins) {
      const market = this.market.readMarket(coin);
      if (market === null) {
        continue;
      }
      const rates = await this.infoClient.fundingHistory(
        coin,
        window.start.getTime(),
        window.end.getTime() - 1,
      );
      for (const rate of rates) {
        const fundingTime = new Date(rate.time);
        for (const copy of paperCopies) {
          if (copy.coin !== coin || copy.openedAt > fundingTime) {
            continue;
          }
          const charged = await this.chains.run(
            copy.book,
            copy.walletAddress,
            () =>
              this.chargeFunding(
                copy.id,
                market.oraclePrice,
                new Decimal(rate.fundingRate),
              ),
          );
          charges += charged ? 1 : 0;
        }
      }
    }
    return { coins: coins.length, charges };
  }

  private async chargeFunding(
    copyId: bigint,
    oraclePrice: Decimal,
    fundingRate: Decimal,
  ): Promise<boolean> {
    const copy = await this.prisma.copyPosition.findUnique({
      where: { id: copyId },
    });
    if (copy === null || !copy.isOpen) {
      return false;
    }
    const payment = fundingPayment({
      size: toDecimal(copy.size),
      oraclePrice,
      fundingRate,
    });
    await this.positions.addFunding(copy.id, payment);
    return true;
  }

  private async refreshMarkets(): Promise<{ markets: number }> {
    return { markets: await this.market.refreshMarkets() };
  }

  async pruneFills(now: Date): Promise<{ deleted: number }> {
    const { count } = await this.prisma.leaderFill.deleteMany({
      where: {
        time: { lt: new Date(now.getTime() - FILL_RETENTION_DAYS * DAY_MS) },
      },
    });
    return { deleted: count };
  }

  private alert(code: string, message: string): void {
    this.logger.error(message);
    this.events.publish({
      type: 'alert',
      code,
      message,
      wallet: null,
      clusterId: null,
    });
  }
}
