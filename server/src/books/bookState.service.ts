import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import type { ServerConfig } from '../config';
import type { BookName, BookView, CopyView, MarketView } from '../copy/types';
import type { CopyPosition, Prisma } from '../generated/prisma/client';
import type { Subscription } from 'rxjs';
import { MarketDataService } from '../market/marketData.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  markBook,
  type MarkedCopy,
  measureCumulativePnl,
  measureNetPnl,
  measureNotionalUsd,
  measurePaperEquity,
  startOfUtcDay,
} from './bookEquity';
import { LiveAccountService } from './liveAccount.service';

export type BookValueKind = 'equity' | 'net_pnl';

export type BookSummary = {
  book: BookName;
  valueKind: BookValueKind;
  valueUsd: Decimal;
  unrealizedPnl: Decimal;
  realizedPnlToday: Decimal;
  grossExposureUsd: Decimal;
  openPositions: number;
  dayStartEquity: Decimal | null;
};

type CashFlowSums = {
  realizedPnl: Prisma.Decimal | null;
  feesUsd: Prisma.Decimal | null;
  fundingUsd: Prisma.Decimal | null;
};

const CASH_FLOW_SUM = {
  realizedPnl: true,
  feesUsd: true,
  fundingUsd: true,
} as const;

function toDecimal(value: Prisma.Decimal | null): Decimal {
  return value === null ? new Decimal(0) : new Decimal(value.toString());
}

function sumNetPnl(sums: CashFlowSums): Decimal {
  return measureNetPnl({
    realizedPnl: toDecimal(sums.realizedPnl),
    feesUsd: toDecimal(sums.feesUsd),
    fundingUsd: toDecimal(sums.fundingUsd),
  });
}

@Injectable()
export class BookStateService implements OnModuleInit, OnModuleDestroy {
  private readonly lastMids = new Map<string, Decimal>();
  private midsSubscription: Subscription | undefined;
  private readonly paperEquityUsd: Decimal;
  private readonly shadowAllocationUsd: Decimal;
  private readonly maxExchangeLeverage: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly market: MarketDataService,
    private readonly liveAccount: LiveAccountService,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.paperEquityUsd = new Decimal(
      config.getOrThrow('PAPER_EQUITY_USD', { infer: true }),
    );
    this.shadowAllocationUsd = new Decimal(
      config.getOrThrow('SHADOW_ALLOCATION_USD', { infer: true }),
    );
    this.maxExchangeLeverage = config.getOrThrow('MAX_EXCHANGE_LEVERAGE', {
      infer: true,
    });
  }

  onModuleInit(): void {
    this.midsSubscription = this.market.mids$.subscribe((update) => {
      for (const [coin, mid] of update.mids) {
        this.lastMids.set(coin, mid);
      }
    });
  }

  onModuleDestroy(): void {
    this.midsSubscription?.unsubscribe();
  }

  async readBookSummary(book: BookName): Promise<BookSummary> {
    const dayStart = startOfUtcDay(new Date());
    const [openRows, closedToday, state] = await Promise.all([
      this.prisma.copyPosition.findMany({ where: { book, isOpen: true } }),
      this.prisma.copyPosition.aggregate({
        where: { book, isOpen: false, closedAt: { gte: dayStart } },
        _sum: CASH_FLOW_SUM,
      }),
      book === 'MAIN'
        ? this.prisma.bookState.findUnique({ where: { book } })
        : Promise.resolve(null),
    ]);
    const marked = markBook(openRows.map((row) => this.markCopy(row)));
    return {
      book,
      valueKind: book === 'MAIN' ? 'equity' : 'net_pnl',
      valueUsd:
        book === 'MAIN'
          ? await this.measureEquity(book, null, marked.unrealizedPnl)
          : measureCumulativePnl({
              netPnlUsd: await this.readNetPnl({ book }),
              unrealizedPnl: marked.unrealizedPnl,
            }),
      unrealizedPnl: marked.unrealizedPnl,
      realizedPnlToday: sumNetPnl(closedToday._sum),
      grossExposureUsd: marked.grossExposureUsd,
      openPositions: openRows.length,
      dayStartEquity:
        state === null ? null : new Decimal(state.dayStartEquity.toString()),
    };
  }

  async readBookView(book: BookName, wallet: string): Promise<BookView> {
    const ledgerWallet = book === 'MAIN' ? null : wallet;
    const [openRows, state] = await Promise.all([
      this.prisma.copyPosition.findMany({
        where: { book, isOpen: true, walletAddress: ledgerWallet ?? undefined },
        orderBy: { id: 'asc' },
      }),
      book === 'MAIN'
        ? this.prisma.bookState.findUnique({ where: { book } })
        : Promise.resolve(null),
    ]);
    const markedCopies = openRows.map((row) => this.markCopy(row));
    const marked = markBook(markedCopies);
    const equityUsd = await this.measureEquity(
      book,
      ledgerWallet,
      marked.unrealizedPnl,
    );
    const freeMarginUsd =
      book === 'MAIN' && this.liveAccount.isLive()
        ? (await this.liveAccount.readAccount()).withdrawableUsd
        : equityUsd.minus(marked.initialMarginUsd);
    return {
      book,
      equityUsd,
      dayStartEquity:
        state === null ? null : new Decimal(state.dayStartEquity.toString()),
      freeMarginUsd,
      killSwitchActive: state?.killSwitchActive ?? false,
      killSwitchReason: state?.killSwitchReason ?? null,
      openCopies: openRows.map((row, index) =>
        this.toCopyView(row, markedCopies[index]),
      ),
    };
  }

  async readMainEquity(): Promise<Decimal> {
    if (this.liveAccount.isLive()) {
      return (await this.liveAccount.readAccount()).equityUsd;
    }
    const openRows = await this.prisma.copyPosition.findMany({
      where: { book: 'MAIN', isOpen: true },
    });
    const marked = markBook(openRows.map((row) => this.markCopy(row)));
    return this.measureEquity('MAIN', null, marked.unrealizedPnl);
  }

  async readCopyView(copyId: bigint): Promise<CopyView | null> {
    const row = await this.prisma.copyPosition.findUnique({
      where: { id: copyId },
    });
    if (row === null || !row.isOpen) {
      return null;
    }
    return this.toCopyView(row, this.markCopy(row));
  }

  readMarketView(coin: string): MarketView | null {
    const market = this.market.readMarket(coin);
    if (market === null) {
      return null;
    }
    const mid = this.market.readMid(coin);
    return {
      coin,
      szDecimals: market.szDecimals,
      maxLeverage: market.maxLeverage,
      onlyIsolated: market.isOnlyIsolated,
      marginMode: market.marginMode,
      isDelisted: false,
      mid: mid?.price ?? null,
      midAt: mid?.receivedAt ?? null,
    };
  }

  readMark(coin: string): Decimal | null {
    return (
      this.market.readMid(coin)?.price ??
      this.market.readMarket(coin)?.markPrice ??
      this.lastMids.get(coin) ??
      null
    );
  }

  private async measureEquity(
    book: BookName,
    ledgerWallet: string | null,
    unrealizedPnl: Decimal,
  ): Promise<Decimal> {
    if (book === 'MAIN' && this.liveAccount.isLive()) {
      return (await this.liveAccount.readAccount()).equityUsd;
    }
    const netPnlUsd = await this.readNetPnl(
      ledgerWallet === null ? { book } : { book, walletAddress: ledgerWallet },
    );
    return measurePaperEquity({
      startingEquityUsd:
        book === 'MAIN' ? this.paperEquityUsd : this.shadowAllocationUsd,
      netPnlUsd,
      unrealizedPnl,
    });
  }

  private async readNetPnl(
    where: Prisma.CopyPositionWhereInput,
  ): Promise<Decimal> {
    const totals = await this.prisma.copyPosition.aggregate({
      where,
      _sum: CASH_FLOW_SUM,
    });
    return sumNetPnl(totals._sum);
  }

  private markCopy(row: CopyPosition): MarkedCopy {
    const market = this.market.readMarket(row.coin);
    return {
      coin: row.coin,
      size: new Decimal(row.size.toString()),
      entryPx:
        row.entryPx === null ? null : new Decimal(row.entryPx.toString()),
      mark: this.readMark(row.coin),
      leverage:
        market === null
          ? 1
          : Math.max(1, Math.min(market.maxLeverage, this.maxExchangeLeverage)),
    };
  }

  private toCopyView(row: CopyPosition, marked: MarkedCopy): CopyView {
    return {
      id: row.id,
      wallet: row.walletAddress,
      coin: row.coin,
      size: marked.size,
      ratio: new Decimal(row.ratio.toString()),
      leaderSizeAtSync: new Decimal(row.leaderSizeAtSync.toString()),
      allocationUsd: new Decimal(row.allocationUsd.toString()),
      notionalUsd: measureNotionalUsd(marked),
      openedAt: row.openedAt,
      lastOrderAt: row.lastOrderAt,
    };
  }
}
