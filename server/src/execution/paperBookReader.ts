import { Inject, Injectable } from '@nestjs/common';
import { HyperliquidInfoClient, RateLimitedError } from '@remora/sdk';
import { PAPER_BOOK_INFO_CLIENT } from '../hyperliquid/hyperliquid.module';
import { type OrderBook, readOrderBook } from '../market/marketData.service';
import { MetricsService } from '../metrics/metrics.service';

export const BOOK_REUSE_MS = 500;
const PROCESS_LABEL = 'server';

type BookRead = {
  startedAt: number;
  readAt: number | null;
  book: Promise<OrderBook>;
};

@Injectable()
export class PaperBookReader {
  private readonly latestReads = new Map<string, BookRead>();

  constructor(
    @Inject(PAPER_BOOK_INFO_CLIENT)
    private readonly infoClient: HyperliquidInfoClient,
    private readonly metrics: MetricsService,
  ) {}

  readBook(coin: string, notBefore: number): Promise<OrderBook> {
    const latest = this.latestReads.get(coin);
    const isShareable =
      latest !== undefined &&
      latest.startedAt >= notBefore &&
      (latest.readAt === null || Date.now() - latest.readAt <= BOOK_REUSE_MS);
    if (isShareable) {
      return latest.book;
    }
    const read: BookRead = {
      startedAt: Date.now(),
      readAt: null,
      book: this.fetchBook(coin).then(
        (book) => {
          read.readAt = Date.now();
          return book;
        },
        (error: unknown) => {
          if (this.latestReads.get(coin) === read) {
            this.latestReads.delete(coin);
          }
          throw error;
        },
      ),
    };
    this.latestReads.set(coin, read);
    return read.book;
  }

  private async fetchBook(coin: string): Promise<OrderBook> {
    try {
      return readOrderBook(await this.infoClient.l2Book(coin));
    } catch (error) {
      if (error instanceof RateLimitedError) {
        this.metrics.hyperliquidRateLimitedTotal.inc({
          process: PROCESS_LABEL,
        });
      }
      throw error;
    }
  }
}
