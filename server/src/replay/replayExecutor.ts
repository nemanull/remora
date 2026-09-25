import { Decimal } from 'decimal.js';
import {
  type ExecutionResult,
  type Executor,
  IOC_UNFILLED,
  type OrderRequest,
} from '../execution/types';

const BASIS_POINTS = 10_000;

export const MEDIAN_SWEEP_BPS = 1.4;

export function measureDriftedMid(
  leaderVwap: Decimal,
  isLeaderBuying: boolean,
  driftBps: number,
): Decimal {
  const drift = new Decimal(driftBps).div(BASIS_POINTS);
  return isLeaderBuying
    ? leaderVwap.mul(drift.plus(1))
    : leaderVwap.mul(new Decimal(1).minus(drift));
}

export class ReplayExecutor implements Executor {
  private readonly mids = new Map<string, Decimal>();
  private clock = new Date(0);

  constructor(
    private readonly takerFeeBps: number,
    private readonly sweepBps = MEDIAN_SWEEP_BPS,
  ) {}

  setMarket(coin: string, mid: Decimal, at: Date): void {
    this.mids.set(coin, mid);
    this.clock = at;
  }

  execute(order: OrderRequest): Promise<ExecutionResult> {
    const mid = this.mids.get(order.coin);
    if (mid === undefined) {
      return Promise.resolve(this.reject('mid_unavailable'));
    }
    const sweep = mid.mul(this.sweepBps).div(BASIS_POINTS);
    const price = order.isBuy ? mid.plus(sweep) : mid.minus(sweep);
    const size = order.reduceOnly
      ? Decimal.min(order.size, order.heldSize.abs())
      : order.size;
    const isBeyondLimit = order.isBuy
      ? price.gt(order.limitPx)
      : price.lt(order.limitPx);
    if (isBeyondLimit || size.lte(0)) {
      return Promise.resolve({
        ...this.reject(IOC_UNFILLED),
        status: 'UNFILLED',
      });
    }
    return Promise.resolve({
      status: 'FILLED',
      filledSize: size,
      averagePrice: price,
      feeUsd: size.mul(price).mul(this.takerFeeBps).div(BASIS_POINTS),
      exchangeOid: null,
      error: null,
      acknowledgedAt: this.clock,
    });
  }

  private reject(error: string): ExecutionResult {
    return {
      status: 'REJECTED',
      filledSize: new Decimal(0),
      averagePrice: null,
      feeUsd: new Decimal(0),
      exchangeOid: null,
      error,
      acknowledgedAt: this.clock,
    };
  }
}
