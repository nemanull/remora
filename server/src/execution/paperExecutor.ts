import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import type { ServerConfig } from '../config';
import type { OrderBook } from '../market/marketData.service';
import { walkBook } from './bookWalk';
import { PaperBookReader } from './paperBookReader';
import {
  type ExecutionResult,
  type Executor,
  IOC_UNFILLED,
  type OrderRequest,
} from './types';

const BASIS_POINTS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fillFromBook(
  order: OrderRequest,
  book: OrderBook,
  takerFeeBps: number,
  acknowledgedAt: Date,
): ExecutionResult {
  const size = order.reduceOnly
    ? Decimal.min(order.size, order.heldSize.abs())
    : order.size;
  const walk = walkBook(
    order.isBuy ? book.asks : book.bids,
    order.isBuy,
    Decimal.max(size, 0),
    order.limitPx,
  );
  const feeUsd =
    walk.averagePrice === null
      ? new Decimal(0)
      : walk.filledSize
          .mul(walk.averagePrice)
          .mul(takerFeeBps)
          .div(BASIS_POINTS);
  const status = walk.filledSize.isZero()
    ? 'UNFILLED'
    : walk.filledSize.gte(size)
      ? 'FILLED'
      : 'PARTIALLY_FILLED';
  return {
    status,
    filledSize: walk.filledSize,
    averagePrice: walk.averagePrice,
    feeUsd,
    exchangeOid: null,
    error: status === 'UNFILLED' ? IOC_UNFILLED : null,
    acknowledgedAt,
  };
}

@Injectable()
export class PaperExecutor implements Executor {
  private readonly latencyMs: number;
  private readonly takerFeeBps: number;

  constructor(
    private readonly books: PaperBookReader,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.latencyMs = config.getOrThrow('PAPER_ORDER_LATENCY_MS', {
      infer: true,
    });
    this.takerFeeBps = config.getOrThrow('TAKER_FEE_BPS', { infer: true });
  }

  async execute(order: OrderRequest): Promise<ExecutionResult> {
    const waitStartedAt = Date.now();
    await sleep(this.latencyMs);
    let book: OrderBook;
    try {
      book = await this.books.readBook(order.coin, waitStartedAt);
    } catch (error) {
      return {
        status: 'REJECTED',
        filledSize: new Decimal(0),
        averagePrice: null,
        feeUsd: new Decimal(0),
        exchangeOid: null,
        error: `book_unavailable: ${error instanceof Error ? error.message : String(error)}`,
        acknowledgedAt: new Date(),
      };
    }
    return fillFromBook(order, book, this.takerFeeBps, new Date());
  }
}
