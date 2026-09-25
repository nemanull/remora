import type {
  Candle,
  CandleInterval,
  FundingHistoryItem,
  HyperliquidClearinghouseState,
  HyperliquidFill,
  L2BookResponse,
  MetaAndAssetCtxs,
  NonFundingLedgerUpdate,
  OrderStatusResponse,
  PortfolioResponse,
  UserAbstraction,
  UserRoleResponse,
} from './hyperliquid.js';
import type { WeightBudget } from './weightBudget.js';

const LIGHT_WEIGHT = 2;
const STANDARD_WEIGHT = 20;
const USER_ROLE_WEIGHT = 60;
const ITEMS_PER_EXTRA_WEIGHT = 20;
const CANDLES_PER_EXTRA_WEIGHT = 60;
const RATE_LIMIT_PAUSE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

type InfoRequest = { type: string; [field: string]: unknown };

export class RateLimitedError extends Error {
  constructor(readonly requestType: string) {
    super(`Hyperliquid rate limited the ${requestType} request`);
    this.name = 'RateLimitedError';
  }
}

export class HyperliquidInfoClient {
  private readonly infoUrl: string;

  constructor(
    apiUrl: string,
    private readonly budget: WeightBudget,
  ) {
    this.infoUrl = `${apiUrl.replace(/\/+$/, '')}/info`;
  }

  userFillsByTime(
    user: string,
    startTime: number,
    endTime?: number,
  ): Promise<HyperliquidFill[]> {
    return this.post(
      { type: 'userFillsByTime', user, startTime, endTime },
      STANDARD_WEIGHT,
      ITEMS_PER_EXTRA_WEIGHT,
    );
  }

  userNonFundingLedgerUpdates(
    user: string,
    startTime: number,
    endTime?: number,
  ): Promise<NonFundingLedgerUpdate[]> {
    return this.post(
      { type: 'userNonFundingLedgerUpdates', user, startTime, endTime },
      STANDARD_WEIGHT,
      ITEMS_PER_EXTRA_WEIGHT,
    );
  }

  portfolio(user: string): Promise<PortfolioResponse> {
    return this.post({ type: 'portfolio', user }, STANDARD_WEIGHT);
  }

  clearinghouseState(
    user: string,
    dex?: string,
  ): Promise<HyperliquidClearinghouseState> {
    return this.post({ type: 'clearinghouseState', user, dex }, LIGHT_WEIGHT);
  }

  l2Book(coin: string): Promise<L2BookResponse> {
    return this.post({ type: 'l2Book', coin }, LIGHT_WEIGHT);
  }

  metaAndAssetCtxs(): Promise<MetaAndAssetCtxs> {
    return this.post({ type: 'metaAndAssetCtxs' }, STANDARD_WEIGHT);
  }

  candleSnapshot(
    coin: string,
    interval: CandleInterval,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]> {
    return this.post(
      { type: 'candleSnapshot', req: { coin, interval, startTime, endTime } },
      STANDARD_WEIGHT,
      CANDLES_PER_EXTRA_WEIGHT,
    );
  }

  fundingHistory(
    coin: string,
    startTime: number,
    endTime?: number,
  ): Promise<FundingHistoryItem[]> {
    return this.post(
      { type: 'fundingHistory', coin, startTime, endTime },
      STANDARD_WEIGHT,
      ITEMS_PER_EXTRA_WEIGHT,
    );
  }

  orderStatus(
    user: string,
    oid: number | string,
  ): Promise<OrderStatusResponse> {
    return this.post({ type: 'orderStatus', user, oid }, LIGHT_WEIGHT);
  }

  userAbstraction(user: string): Promise<UserAbstraction> {
    return this.post({ type: 'userAbstraction', user }, STANDARD_WEIGHT);
  }

  userRole(user: string): Promise<UserRoleResponse> {
    return this.post({ type: 'userRole', user }, USER_ROLE_WEIGHT);
  }

  private async post<T>(
    request: InfoRequest,
    baseWeight: number,
    itemsPerExtraWeight?: number,
  ): Promise<T> {
    await this.budget.take(baseWeight);
    const response = await fetch(this.infoUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 429) {
      this.budget.pauseFor(RATE_LIMIT_PAUSE_MS);
      throw new RateLimitedError(request.type);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Hyperliquid ${request.type} request failed with status ${response.status}: ${body.slice(0, 200)}`,
      );
    }
    const data = (await response.json()) as T;
    if (itemsPerExtraWeight !== undefined && Array.isArray(data)) {
      this.budget.charge(Math.floor(data.length / itemsPerExtraWeight));
    }
    return data;
  }
}
