import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HyperliquidInfoClient,
  HyperliquidSocket,
  RateLimitedError,
  reconnectDelayMs,
  type HyperliquidWsFrame,
  type MetaAndAssetCtxs,
  type PerpMarginMode,
} from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { Observable, Subject } from 'rxjs';
import { z } from 'zod';
import type { ServerConfig } from '../config';
import { MetricsService } from '../metrics/metrics.service';

const PROCESS_LABEL = 'server';
const DECIMAL_PATTERN = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

export type Market = {
  coin: string;
  assetIndex: number;
  szDecimals: number;
  maxLeverage: number;
  isOnlyIsolated: boolean;
  marginMode: PerpMarginMode | null;
  fundingRate: Decimal;
  markPrice: Decimal;
  oraclePrice: Decimal;
};

export type Mid = {
  price: Decimal;
  receivedAt: Date;
};

export type MidsUpdate = {
  mids: ReadonlyMap<string, Decimal>;
  receivedAt: Date;
};

export type BookLevel = {
  price: Decimal;
  size: Decimal;
};

export type OrderBook = {
  coin: string;
  time: Date;
  bids: BookLevel[];
  asks: BookLevel[];
};

const decimalString = z.string().regex(DECIMAL_PATTERN);

const metaAndAssetCtxsSchema = z.tuple([
  z.object({
    universe: z.array(
      z.object({
        name: z.string().min(1),
        szDecimals: z.number().int().nonnegative(),
        maxLeverage: z.number().positive(),
        onlyIsolated: z.boolean().optional(),
        isDelisted: z.boolean().optional(),
        marginMode: z.enum(['strictIsolated', 'noCross']).optional(),
      }),
    ),
  }),
  z.array(
    z.object({
      funding: decimalString,
      markPx: decimalString,
      oraclePx: decimalString,
    }),
  ),
]);

const allMidsSchema = z.object({
  mids: z.record(z.string(), decimalString),
});

const bookLevelSchema = z.object({ px: decimalString, sz: decimalString });

const l2BookSchema = z.object({
  coin: z.string(),
  time: z.number().int().nonnegative(),
  levels: z.tuple([z.array(bookLevelSchema), z.array(bookLevelSchema)]),
});

export function readOrderBook(response: unknown): OrderBook {
  const book = l2BookSchema.parse(response);
  const toLevel = (level: { px: string; sz: string }): BookLevel => ({
    price: new Decimal(level.px),
    size: new Decimal(level.sz),
  });
  return {
    coin: book.coin,
    time: new Date(book.time),
    bids: book.levels[0].map(toLevel),
    asks: book.levels[1].map(toLevel),
  };
}

export function readMarkets(response: MetaAndAssetCtxs): Map<string, Market> {
  const [meta, contexts] = metaAndAssetCtxsSchema.parse(response);
  const markets = new Map<string, Market>();
  meta.universe.forEach((asset, assetIndex) => {
    const context = contexts[assetIndex];
    if (asset.isDelisted === true || context === undefined) {
      return;
    }
    markets.set(asset.name, {
      coin: asset.name,
      assetIndex,
      szDecimals: asset.szDecimals,
      maxLeverage: asset.maxLeverage,
      isOnlyIsolated: asset.onlyIsolated === true,
      marginMode: asset.marginMode ?? null,
      fundingRate: new Decimal(context.funding),
      markPrice: new Decimal(context.markPx),
      oraclePrice: new Decimal(context.oraclePx),
    });
  });
  return markets;
}

export function readMids(
  frame: HyperliquidWsFrame,
): Record<string, string> | null {
  if (frame.channel !== 'allMids') {
    return null;
  }
  const parsed = allMidsSchema.safeParse(frame.data);
  return parsed.success ? parsed.data.mids : null;
}

@Injectable()
export class MarketDataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketDataService.name);
  private readonly socket: HyperliquidSocket;
  private readonly midsSubject = new Subject<MidsUpdate>();
  readonly mids$: Observable<MidsUpdate> = this.midsSubject.asObservable();
  private markets = new Map<string, Market>();
  private marketsRefreshedAt: Date | null = null;
  private mids: Record<string, string> = {};
  private midsReceivedAt: Date | null = null;
  private bootAttempt = 0;
  private bootRetryTimer: NodeJS.Timeout | undefined;
  private isStopped = false;

  constructor(
    private readonly infoClient: HyperliquidInfoClient,
    private readonly metrics: MetricsService,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.socket = new HyperliquidSocket({
      url: config.getOrThrow('HYPERLIQUID_WS_URL', { infer: true }),
      onFrame: (frame) => this.handleFrame(frame),
      onResubscribeResult: (result) => {
        if (result.error !== null) {
          this.logger.error(
            `Hyperliquid refused the allMids subscription after a reconnect: ${result.error}`,
          );
        }
      },
      onDisconnect: (reason, reconnectInMs) =>
        this.logger.warn(
          `allMids socket dropped (${reason}), reconnecting in ${reconnectInMs} ms`,
        ),
    });
  }

  async onModuleInit(): Promise<void> {
    this.socket.start();
    void this.socket.subscribe({ type: 'allMids' }).then((result) => {
      if (result.error !== null && result.error !== 'socket_stopped') {
        this.logger.error(
          `Hyperliquid refused the allMids subscription: ${result.error}`,
        );
      }
    });
    await this.loadMarketsAtBoot();
  }

  async onModuleDestroy(): Promise<void> {
    this.isStopped = true;
    clearTimeout(this.bootRetryTimer);
    this.midsSubject.complete();
    await this.socket.stop();
  }

  async refreshMarkets(): Promise<number> {
    let response: MetaAndAssetCtxs;
    try {
      response = await this.infoClient.metaAndAssetCtxs();
    } catch (error) {
      if (error instanceof RateLimitedError) {
        this.metrics.hyperliquidRateLimitedTotal.inc({
          process: PROCESS_LABEL,
        });
      }
      throw error;
    }
    this.markets = readMarkets(response);
    this.marketsRefreshedAt = new Date();
    this.logger.log(`Loaded ${this.markets.size} live main-dex perps`);
    return this.markets.size;
  }

  hasMarkets(): boolean {
    return this.markets.size > 0;
  }

  readMarkets(): ReadonlyMap<string, Market> {
    return this.markets;
  }

  readMarket(coin: string): Market | null {
    return this.markets.get(coin) ?? null;
  }

  readMarketsRefreshedAt(): Date | null {
    return this.marketsRefreshedAt;
  }

  readMid(coin: string): Mid | null {
    const price = this.mids[coin];
    if (price === undefined || this.midsReceivedAt === null) {
      return null;
    }
    return { price: new Decimal(price), receivedAt: this.midsReceivedAt };
  }

  private async loadMarketsAtBoot(): Promise<void> {
    try {
      await this.refreshMarkets();
    } catch (error) {
      const delay = reconnectDelayMs(this.bootAttempt);
      this.bootAttempt += 1;
      this.logger.error(
        `Failed to load markets, the cluster link stays closed and retries in ${delay} ms`,
        error instanceof Error ? error.stack : String(error),
      );
      if (!this.isStopped) {
        this.bootRetryTimer = setTimeout(
          () => void this.loadMarketsAtBoot(),
          delay,
        );
      }
    }
  }

  private handleFrame(frame: HyperliquidWsFrame): void {
    const mids = readMids(frame);
    if (mids === null) {
      return;
    }
    const receivedAt = new Date();
    this.mids = mids;
    this.midsReceivedAt = receivedAt;
    if (!this.midsSubject.observed) {
      return;
    }
    const marketMids = new Map<string, Decimal>();
    for (const coin of this.markets.keys()) {
      const price = mids[coin];
      if (price !== undefined) {
        marketMids.set(coin, new Decimal(price));
      }
    }
    this.midsSubject.next({ mids: marketMids, receivedAt });
  }
}
