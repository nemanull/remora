import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { Observable, Subject, Subscription } from 'rxjs';
import type { ServerConfig } from '../config';
import type { BookName } from '../copy/types';
import type { CopyPosition } from '../generated/prisma/client';
import {
  MarketDataService,
  type MidsUpdate,
} from '../market/marketData.service';
import { PrismaService } from '../prisma/prisma.service';

export type StopTrigger = {
  book: BookName;
  wallet: string;
  copyId: bigint;
  coin: string;
  stopPx: Decimal;
  mid: Decimal;
};

type WatchedStop = {
  book: BookName;
  wallet: string;
  coin: string;
  stopPx: Decimal;
  isLong: boolean;
};

export function isStopCrossed(
  stop: { isLong: boolean; stopPx: Decimal },
  mid: Decimal,
): boolean {
  return stop.isLong ? mid.lte(stop.stopPx) : mid.gte(stop.stopPx);
}

@Injectable()
export class PaperStopsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaperStopsService.name);
  private readonly stops = new Map<bigint, WatchedStop>();
  private readonly triggerSubject = new Subject<StopTrigger>();
  readonly triggers$: Observable<StopTrigger> =
    this.triggerSubject.asObservable();
  private readonly isMainBookPaper: boolean;
  private midsSubscription: Subscription | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly market: MarketDataService,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.isMainBookPaper =
      config.getOrThrow('EXECUTION_MODE', { infer: true }) === 'paper';
  }

  async onModuleInit(): Promise<void> {
    const copies = await this.prisma.copyPosition.findMany({
      where: {
        isOpen: true,
        stopPx: { not: null },
        book: { in: this.isMainBookPaper ? ['MAIN', 'SHADOW'] : ['SHADOW'] },
      },
    });
    for (const copy of copies) {
      this.trackStop(copy);
    }
    this.midsSubscription = this.market.mids$.subscribe((update) =>
      this.checkStops(update),
    );
    this.logger.log(`Watching ${this.stops.size} paper stops`);
  }

  onModuleDestroy(): void {
    this.midsSubscription?.unsubscribe();
    this.triggerSubject.complete();
  }

  isPaperBook(book: BookName): boolean {
    return book === 'SHADOW' || this.isMainBookPaper;
  }

  trackStop(copy: CopyPosition): void {
    if (copy.stopPx === null || !copy.isOpen || !this.isPaperBook(copy.book)) {
      this.stops.delete(copy.id);
      return;
    }
    const size = new Decimal(copy.size.toString());
    if (size.isZero()) {
      this.stops.delete(copy.id);
      return;
    }
    this.stops.set(copy.id, {
      book: copy.book,
      wallet: copy.walletAddress,
      coin: copy.coin,
      stopPx: new Decimal(copy.stopPx.toString()),
      isLong: size.isPositive(),
    });
  }

  untrackStop(copyId: bigint): void {
    this.stops.delete(copyId);
  }

  private checkStops(update: MidsUpdate): void {
    for (const [copyId, stop] of this.stops) {
      const mid = update.mids.get(stop.coin);
      if (mid === undefined || !isStopCrossed(stop, mid)) {
        continue;
      }
      this.stops.delete(copyId);
      this.logger.log(
        `Paper stop of copy ${copyId} on ${stop.coin} in the ${stop.book} book crossed at ${mid.toFixed()} against ${stop.stopPx.toFixed()}`,
      );
      this.triggerSubject.next({
        book: stop.book,
        wallet: stop.wallet,
        copyId,
        coin: stop.coin,
        stopPx: stop.stopPx,
        mid,
      });
    }
  }
}
