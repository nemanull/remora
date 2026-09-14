import {
  ApiRequestError,
  type ExchangeClient,
  ValidationError,
} from '@nktkas/hyperliquid';
import type {
  HyperliquidFill,
  HyperliquidInfoClient,
  WeightBudget,
} from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { readFileSync } from 'node:fs';
import type { Market } from '../market/marketData.service';
import {
  type ExecutionResult,
  type Executor,
  IOC_UNFILLED,
  type OrderRequest,
} from './types';

export type ExchangeActions = Pick<
  ExchangeClient,
  'order' | 'cancelByCloid' | 'updateLeverage'
>;

export type MarketLookup = {
  readMarket(coin: string): Market | null;
};

export type LiveExecutorSettings = {
  accountAddress: string;
  agentAddress: string;
  orderExpiryMs: number;
  takerFeeBps: number;
  maxExchangeLeverage: number;
};

export type StopOrder = {
  cloid: string;
  coin: string;
  isLong: boolean;
  size: Decimal;
  triggerPx: Decimal;
  limitPx: Decimal;
};

export type StopPlacement = {
  status: 'SUBMITTED' | 'REJECTED' | 'UNKNOWN';
  exchangeOid: bigint | null;
  error: string | null;
  acknowledgedAt: Date | null;
};

type OrderStatusEntry = Awaited<
  ReturnType<ExchangeActions['order']>
>['response']['data']['statuses'][number];

const REFUSED_ABSTRACTIONS = new Set(['unifiedAccount', 'portfolioMargin']);
const AGENT_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;
const NO_MATCH_PATTERN = /could not immediately match/i;
const ALREADY_GONE_PATTERN = /never placed, already canceled, or filled/i;
const ORDER_INDEX_PREFIX = /^Order \d+: /;
const RESOLVE_MARGIN_MS = 1_000;
const RESOLVE_ATTEMPTS = 3;
const RESOLVE_RETRY_MS = 2_000;
const FILL_LOOKBACK_MS = 1_000;
const BASIS_POINTS = 10_000;
const CANCELLED_STATUS = 'canceled';
const FILLED_STATUS = 'filled';
const LIVE_STATUSES = new Set(['open', 'triggered']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readAgentKey(path: string): `0x${string}` {
  const key = readFileSync(path, 'utf8').trim();
  if (!AGENT_KEY_PATTERN.test(key)) {
    throw new Error(`The agent key file ${path} does not hold a hex key`);
  }
  return key.startsWith('0x') ? (key as `0x${string}`) : `0x${key}`;
}

export function readExchangeError(error: ApiRequestError): string {
  return error.message.replace(ORDER_INDEX_PREFIX, '');
}

function emptyResult(
  status: ExecutionResult['status'],
  error: string | null,
  acknowledgedAt: Date | null,
): ExecutionResult {
  return {
    status,
    filledSize: new Decimal(0),
    averagePrice: null,
    feeUsd: new Decimal(0),
    exchangeOid: null,
    error,
    acknowledgedAt,
  };
}

export class LiveExecutor implements Executor {
  private readonly leveragedCoins = new Set<string>();

  constructor(
    private readonly exchange: ExchangeActions,
    private readonly info: HyperliquidInfoClient,
    private readonly budget: WeightBudget,
    private readonly markets: MarketLookup,
    private readonly settings: LiveExecutorSettings,
  ) {}

  readAccountAddress(): string {
    return this.settings.accountAddress;
  }

  async verifyAccount(): Promise<void> {
    const { accountAddress, agentAddress } = this.settings;
    const abstraction = await this.info.userAbstraction(accountAddress);
    if (REFUSED_ABSTRACTIONS.has(abstraction)) {
      throw new Error(
        `Live mode refused: account ${accountAddress} runs ${abstraction}, which makes its equity unreadable`,
      );
    }
    const role = await this.info.userRole(agentAddress);
    if (
      role.role !== 'agent' ||
      role.data.user.toLowerCase() !== accountAddress
    ) {
      throw new Error(
        `Live mode refused: ${agentAddress} is not an agent of account ${accountAddress}`,
      );
    }
  }

  async ensureLeverage(coin: string): Promise<void> {
    if (this.leveragedCoins.has(coin)) {
      return;
    }
    const market = this.requireMarket(coin);
    await this.budget.take(1);
    await this.exchange.updateLeverage({
      asset: market.assetIndex,
      isCross: true,
      leverage: Math.max(
        1,
        Math.min(market.maxLeverage, this.settings.maxExchangeLeverage),
      ),
    });
    this.leveragedCoins.add(coin);
  }

  async execute(order: OrderRequest): Promise<ExecutionResult> {
    const market = this.markets.readMarket(order.coin);
    if (market === null) {
      return emptyResult('REJECTED', 'unsupported_instrument', new Date());
    }
    if (!order.reduceOnly) {
      try {
        await this.ensureLeverage(order.coin);
      } catch (error) {
        return emptyResult(
          'REJECTED',
          `leverage_not_set: ${error instanceof Error ? error.message : String(error)}`,
          new Date(),
        );
      }
    }
    await this.budget.take(1);
    const signedAt = new Date();
    try {
      const response = await this.exchange.order({
        orders: [
          {
            a: market.assetIndex,
            b: order.isBuy,
            p: order.limitPx.toFixed(),
            s: order.size.toFixed(),
            r: order.reduceOnly,
            t: { limit: { tif: 'Ioc' } },
            c: order.cloid,
          },
        ],
        grouping: 'na',
      });
      return await this.readOrderStatus(
        order,
        response.response.data.statuses[0],
        signedAt,
      );
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const message = readExchangeError(error);
        return NO_MATCH_PATTERN.test(message)
          ? emptyResult('UNFILLED', IOC_UNFILLED, new Date())
          : emptyResult('REJECTED', message, new Date());
      }
      if (error instanceof ValidationError) {
        return emptyResult('REJECTED', error.message, new Date());
      }
      return this.resolveOrder(order, signedAt);
    }
  }

  async resolveOrder(
    order: OrderRequest,
    signedAt: Date,
  ): Promise<ExecutionResult> {
    const waitMs =
      signedAt.getTime() +
      this.settings.orderExpiryMs +
      RESOLVE_MARGIN_MS -
      Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    let lastError = 'order status unavailable';
    for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS; attempt += 1) {
      try {
        return await this.lookUpOrder(order, signedAt);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < RESOLVE_ATTEMPTS) {
          await sleep(RESOLVE_RETRY_MS * attempt);
        }
      }
    }
    return emptyResult('UNKNOWN', lastError, null);
  }

  async placeStop(stop: StopOrder): Promise<StopPlacement> {
    const market = this.requireMarket(stop.coin);
    await this.budget.take(1);
    const signedAt = new Date();
    try {
      const response = await this.exchange.order({
        orders: [
          {
            a: market.assetIndex,
            b: !stop.isLong,
            p: stop.limitPx.toFixed(),
            s: stop.size.toFixed(),
            r: true,
            t: {
              trigger: {
                isMarket: true,
                triggerPx: stop.triggerPx.toFixed(),
                tpsl: 'sl',
              },
            },
            c: stop.cloid,
          },
        ],
        grouping: 'positionTpsl',
      });
      const status = response.response.data.statuses[0];
      return {
        status: 'SUBMITTED',
        exchangeOid:
          typeof status === 'object' && 'resting' in status
            ? BigInt(status.resting.oid)
            : null,
        error: null,
        acknowledgedAt: new Date(),
      };
    } catch (error) {
      if (
        error instanceof ApiRequestError ||
        error instanceof ValidationError
      ) {
        return {
          status: 'REJECTED',
          exchangeOid: null,
          error:
            error instanceof ApiRequestError
              ? readExchangeError(error)
              : error.message,
          acknowledgedAt: new Date(),
        };
      }
      return this.resolveStop(stop, signedAt);
    }
  }

  async cancelOrder(coin: string, cloid: string): Promise<boolean> {
    const market = this.requireMarket(coin);
    await this.budget.take(1);
    try {
      await this.exchange.cancelByCloid({
        cancels: [{ asset: market.assetIndex, cloid: cloid }],
      });
      return true;
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        ALREADY_GONE_PATTERN.test(readExchangeError(error))
      ) {
        return false;
      }
      throw error;
    }
  }

  private requireMarket(coin: string): Market {
    const market = this.markets.readMarket(coin);
    if (market === null) {
      throw new Error(`${coin} is not a listed main-dex perp`);
    }
    return market;
  }

  private async readOrderStatus(
    order: OrderRequest,
    status: OrderStatusEntry,
    signedAt: Date,
  ): Promise<ExecutionResult> {
    if (typeof status === 'object' && 'filled' in status) {
      const filledSize = new Decimal(status.filled.totalSz);
      const averagePrice = new Decimal(status.filled.avgPx);
      return {
        status: filledSize.gte(order.size) ? 'FILLED' : 'PARTIALLY_FILLED',
        filledSize,
        averagePrice,
        feeUsd: this.estimateFee(filledSize, averagePrice),
        exchangeOid: BigInt(status.filled.oid),
        error: null,
        acknowledgedAt: new Date(),
      };
    }
    return this.resolveOrder(order, signedAt);
  }

  private async lookUpOrder(
    order: OrderRequest,
    signedAt: Date,
  ): Promise<ExecutionResult> {
    const response = await this.info.orderStatus(
      this.settings.accountAddress,
      order.cloid,
    );
    if (response.status === 'unknownOid') {
      return emptyResult('UNFILLED', 'never_placed', new Date());
    }
    const { order: placed, status } = response.order;
    const exchangeOid = BigInt(placed.oid);
    if (LIVE_STATUSES.has(status)) {
      return { ...emptyResult('UNKNOWN', status, null), exchangeOid };
    }
    const filledSize = new Decimal(placed.origSz).minus(placed.sz);
    if (filledSize.lte(0)) {
      const error = status === CANCELLED_STATUS ? IOC_UNFILLED : status;
      return {
        ...emptyResult(
          status.endsWith('Rejected') || status === 'rejected'
            ? 'REJECTED'
            : 'UNFILLED',
          error,
          new Date(),
        ),
        exchangeOid,
      };
    }
    const fills = await this.readOrderFills(placed.oid, signedAt);
    const averagePrice =
      fills === null ? new Decimal(placed.limitPx) : fills.averagePrice;
    return {
      status:
        status === FILLED_STATUS && filledSize.gte(order.size)
          ? 'FILLED'
          : 'PARTIALLY_FILLED',
      filledSize,
      averagePrice,
      feeUsd: fills?.feeUsd ?? this.estimateFee(filledSize, averagePrice),
      exchangeOid,
      error: status === FILLED_STATUS ? null : status,
      acknowledgedAt: new Date(),
    };
  }

  private async readOrderFills(
    oid: number,
    signedAt: Date,
  ): Promise<{ averagePrice: Decimal; feeUsd: Decimal } | null> {
    const fills: HyperliquidFill[] = await this.info.userFillsByTime(
      this.settings.accountAddress,
      signedAt.getTime() - FILL_LOOKBACK_MS,
    );
    let size = new Decimal(0);
    let notional = new Decimal(0);
    let feeUsd = new Decimal(0);
    for (const fill of fills) {
      if (fill.oid !== oid) {
        continue;
      }
      size = size.plus(fill.sz);
      notional = notional.plus(new Decimal(fill.sz).mul(fill.px));
      feeUsd = feeUsd.plus(fill.fee);
    }
    return size.isZero() ? null : { averagePrice: notional.div(size), feeUsd };
  }

  private async resolveStop(
    stop: StopOrder,
    signedAt: Date,
  ): Promise<StopPlacement> {
    const result = await this.resolveOrder(
      {
        cloid: stop.cloid,
        coin: stop.coin,
        isBuy: !stop.isLong,
        size: stop.size,
        limitPx: stop.limitPx,
        reduceOnly: true,
        heldSize: stop.size,
      },
      signedAt,
    );
    const isPlaced =
      result.exchangeOid !== null &&
      (result.status === 'UNKNOWN' ||
        result.status === 'FILLED' ||
        result.status === 'PARTIALLY_FILLED');
    return {
      status: isPlaced
        ? 'SUBMITTED'
        : result.status === 'UNKNOWN'
          ? 'UNKNOWN'
          : 'REJECTED',
      exchangeOid: result.exchangeOid,
      error: isPlaced ? null : result.error,
      acknowledgedAt: result.acknowledgedAt ?? new Date(),
    };
  }

  private estimateFee(size: Decimal, price: Decimal): Decimal {
    return size.mul(price).mul(this.settings.takerFeeBps).div(BASIS_POINTS);
  }
}
