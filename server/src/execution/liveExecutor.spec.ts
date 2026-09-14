import { ApiRequestError, HttpRequestError } from '@nktkas/hyperliquid';
import type {
  HyperliquidFill,
  HyperliquidInfoClient,
  OrderStatusResponse,
  WeightBudget,
} from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Market } from '../market/marketData.service';
import { LiveExecutor, type LiveExecutorSettings } from './liveExecutor';
import type { OrderRequest } from './types';

const ACCOUNT = '0x3333333333333333333333333333333333333333';
const AGENT = '0x4444444444444444444444444444444444444444';
const CLOID = '0x0123456789abcdef0123456789abcdef';
const SETTINGS: LiveExecutorSettings = {
  accountAddress: ACCOUNT,
  agentAddress: AGENT,
  orderExpiryMs: 5_000,
  takerFeeBps: 4.5,
  maxExchangeLeverage: 5,
};

const ETH = {
  coin: 'ETH',
  assetIndex: 1,
  szDecimals: 4,
  maxLeverage: 25,
} as Market;

function orderResponse(status: unknown) {
  return {
    status: 'ok',
    response: { type: 'order', data: { statuses: [status] } },
  };
}

function apiError(response: unknown): ApiRequestError {
  return new ApiRequestError(response);
}

function placedOrder(
  status: string,
  origSz: string,
  sz: string,
): OrderStatusResponse {
  return {
    status: 'order',
    order: {
      order: {
        coin: 'ETH',
        side: 'B',
        limitPx: '3131',
        sz,
        oid: 9001,
        timestamp: 0,
        triggerCondition: 'N/A',
        isTrigger: false,
        triggerPx: '0.0',
        children: [],
        isPositionTpsl: false,
        reduceOnly: false,
        orderType: 'Limit',
        origSz,
        tif: 'Ioc',
        cloid: CLOID,
      },
      status: status as 'filled',
      statusTimestamp: 0,
    },
  };
}

function accountFill(oid: number, sz: string, px: string, fee: string) {
  return { oid, sz, px, fee } as HyperliquidFill;
}

function order(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    cloid: CLOID,
    coin: 'ETH',
    isBuy: true,
    size: new Decimal('1.5'),
    limitPx: new Decimal(3_131),
    reduceOnly: false,
    heldSize: new Decimal(0),
    ...overrides,
  };
}

function createExecutor() {
  const exchange = {
    order: vi.fn(),
    cancelByCloid: vi.fn(),
    updateLeverage: vi.fn().mockResolvedValue({ status: 'ok' }),
  };
  const info = {
    userAbstraction: vi.fn().mockResolvedValue('default'),
    userRole: vi
      .fn()
      .mockResolvedValue({ role: 'agent', data: { user: ACCOUNT } }),
    orderStatus: vi.fn(),
    userFillsByTime: vi.fn().mockResolvedValue([]),
  };
  const budget = { take: vi.fn().mockResolvedValue(undefined) };
  const executor = new LiveExecutor(
    exchange,
    info as unknown as HyperliquidInfoClient,
    budget as unknown as WeightBudget,
    { readMarket: (coin: string) => (coin === 'ETH' ? ETH : null) },
    SETTINGS,
  );
  return { executor, exchange, info, budget };
}

describe('LiveExecutor boot checks', () => {
  it('accepts a standard account whose agent signs for it', async () => {
    const { executor, info } = createExecutor();
    await expect(executor.verifyAccount()).resolves.toBeUndefined();
    expect(info.userAbstraction).toHaveBeenCalledWith(ACCOUNT);
    expect(info.userRole).toHaveBeenCalledWith(AGENT);
  });

  it.each(['unifiedAccount', 'portfolioMargin'])(
    'refuses live mode on a %s account',
    async (abstraction) => {
      const { executor, info } = createExecutor();
      info.userAbstraction.mockResolvedValue(abstraction);
      await expect(executor.verifyAccount()).rejects.toThrow(abstraction);
    },
  );

  it('refuses an agent that belongs to another account', async () => {
    const { executor, info } = createExecutor();
    info.userRole.mockResolvedValue({
      role: 'agent',
      data: { user: '0x5555555555555555555555555555555555555555' },
    });
    await expect(executor.verifyAccount()).rejects.toThrow(
      'is not an agent of account',
    );
  });

  it('refuses a key that is not an agent at all', async () => {
    const { executor, info } = createExecutor();
    info.userRole.mockResolvedValue({ role: 'user' });
    await expect(executor.verifyAccount()).rejects.toThrow();
  });
});

describe('LiveExecutor orders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends an IOC limit with the cloid after taking weight and setting leverage once', async () => {
    const { executor, exchange, budget } = createExecutor();
    exchange.order.mockResolvedValue(
      orderResponse({ filled: { totalSz: '1.5', avgPx: '3120.5', oid: 77 } }),
    );
    await executor.execute(order());
    await executor.execute(order());
    expect(exchange.updateLeverage).toHaveBeenCalledTimes(1);
    expect(exchange.updateLeverage).toHaveBeenCalledWith({
      asset: 1,
      isCross: true,
      leverage: 5,
    });
    expect(exchange.order).toHaveBeenCalledWith({
      orders: [
        {
          a: 1,
          b: true,
          p: '3131',
          s: '1.5',
          r: false,
          t: { limit: { tif: 'Ioc' } },
          c: CLOID,
        },
      ],
      grouping: 'na',
    });
    expect(budget.take).toHaveBeenCalledWith(1);
    expect(budget.take).toHaveBeenCalledTimes(3);
  });

  it('reads a full fill with its oid and the taker fee', async () => {
    const { executor, exchange } = createExecutor();
    exchange.order.mockResolvedValue(
      orderResponse({ filled: { totalSz: '1.5', avgPx: '3120', oid: 77 } }),
    );
    const result = await executor.execute(order());
    expect(result.status).toBe('FILLED');
    expect(result.exchangeOid).toBe(77n);
    expect(result.averagePrice?.toFixed()).toBe('3120');
    expect(result.feeUsd.toFixed()).toBe('2.106');
  });

  it('reads a partial fill when the IOC cancelled the rest', async () => {
    const { executor, exchange } = createExecutor();
    exchange.order.mockResolvedValue(
      orderResponse({ filled: { totalSz: '0.4', avgPx: '3120', oid: 78 } }),
    );
    const result = await executor.execute(order());
    expect(result.status).toBe('PARTIALLY_FILLED');
    expect(result.filledSize.toFixed()).toBe('0.4');
  });

  it('records an IOC that matched nothing as unfilled', async () => {
    const { executor, exchange } = createExecutor();
    exchange.order.mockRejectedValue(
      apiError(
        orderResponse({
          error:
            'Order could not immediately match against any resting orders. asset=1',
        }),
      ),
    );
    const result = await executor.execute(order());
    expect(result).toMatchObject({ status: 'UNFILLED', error: 'ioc_unfilled' });
  });

  it('records a per-order error as a rejection with the exchange text', async () => {
    const { executor, exchange } = createExecutor();
    exchange.order.mockRejectedValue(
      apiError(
        orderResponse({ error: 'Order must have minimum value of $10.' }),
      ),
    );
    const result = await executor.execute(order());
    expect(result).toMatchObject({
      status: 'REJECTED',
      error: 'Order must have minimum value of $10.',
    });
  });

  it('records a refused action as a rejection', async () => {
    const { executor, exchange } = createExecutor();
    exchange.order.mockRejectedValue(
      apiError({ status: 'err', response: 'Action already expired' }),
    );
    const result = await executor.execute(order({ reduceOnly: true }));
    expect(result).toMatchObject({
      status: 'REJECTED',
      error: 'Action already expired',
    });
    expect(exchange.updateLeverage).not.toHaveBeenCalled();
  });

  it('rejects an entry whose leverage cannot be set without sending it', async () => {
    const { executor, exchange } = createExecutor();
    exchange.updateLeverage.mockRejectedValue(new Error('margin mode locked'));
    const result = await executor.execute(order());
    expect(result.status).toBe('REJECTED');
    expect(result.error).toContain('leverage_not_set');
    expect(exchange.order).not.toHaveBeenCalled();
  });

  it('resolves a timeout by cloid only after the expiry and finds it never placed', async () => {
    const { executor, exchange, info } = createExecutor();
    exchange.order.mockRejectedValue(
      new HttpRequestError(undefined, { cause: new Error('timeout') }),
    );
    info.orderStatus.mockResolvedValue({ status: 'unknownOid' });
    const pending = executor.execute(order());
    await vi.advanceTimersByTimeAsync(5_500);
    expect(info.orderStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(info.orderStatus).toHaveBeenCalledWith(ACCOUNT, CLOID);
    expect(result).toMatchObject({ status: 'UNFILLED', error: 'never_placed' });
  });

  it('resolves a timeout that filled with the exact fills of the order', async () => {
    const { executor, exchange, info } = createExecutor();
    exchange.order.mockRejectedValue(
      new HttpRequestError(undefined, { cause: new Error('timeout') }),
    );
    info.orderStatus.mockResolvedValue(placedOrder('filled', '1.5', '0.0'));
    info.userFillsByTime.mockResolvedValue([
      accountFill(9001, '1', '3120', '1.40'),
      accountFill(9001, '0.5', '3126', '0.70'),
      accountFill(42, '9', '1', '9'),
    ]);
    const pending = executor.execute(order());
    await vi.advanceTimersByTimeAsync(7_000);
    const result = await pending;
    expect(result.status).toBe('FILLED');
    expect(result.exchangeOid).toBe(9001n);
    expect(result.averagePrice?.toFixed()).toBe('3122');
    expect(result.feeUsd.toFixed()).toBe('2.1');
  });

  it('resolves an unknown waiting status as a partial fill of a cancelled IOC', async () => {
    const { executor, exchange, info } = createExecutor();
    exchange.order.mockResolvedValue(orderResponse('waitingForFill'));
    info.orderStatus.mockResolvedValue(placedOrder('canceled', '1.5', '1.0'));
    const pending = executor.execute(order());
    await vi.advanceTimersByTimeAsync(7_000);
    const result = await pending;
    expect(result.status).toBe('PARTIALLY_FILLED');
    expect(result.filledSize.toFixed()).toBe('0.5');
    expect(result.averagePrice?.toFixed()).toBe('3131');
  });

  it('keeps the order unknown when its status cannot be read', async () => {
    const { executor, exchange, info } = createExecutor();
    exchange.order.mockRejectedValue(
      new HttpRequestError(undefined, { cause: new Error('timeout') }),
    );
    info.orderStatus.mockRejectedValue(new Error('socket hang up'));
    const pending = executor.execute(order());
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect(result.status).toBe('UNKNOWN');
    expect(info.orderStatus).toHaveBeenCalledTimes(3);
  });
});

describe('LiveExecutor stops', () => {
  const stop = {
    cloid: CLOID,
    coin: 'ETH',
    isLong: true,
    size: new Decimal('1.5'),
    triggerPx: new Decimal(2_450),
    limitPx: new Decimal('2376.5'),
  };

  it('places a reduce-only stop-market trigger grouped with the position', async () => {
    const { executor, exchange } = createExecutor();
    exchange.order.mockResolvedValue(orderResponse({ resting: { oid: 501 } }));
    const placement = await executor.placeStop(stop);
    expect(placement).toMatchObject({ status: 'SUBMITTED', exchangeOid: 501n });
    expect(exchange.order).toHaveBeenCalledWith({
      orders: [
        {
          a: 1,
          b: false,
          p: '2376.5',
          s: '1.5',
          r: true,
          t: { trigger: { isMarket: true, triggerPx: '2450', tpsl: 'sl' } },
          c: CLOID,
        },
      ],
      grouping: 'positionTpsl',
    });
  });

  it('reports a refused stop with the exchange text', async () => {
    const { executor, exchange } = createExecutor();
    exchange.order.mockRejectedValue(
      apiError(orderResponse({ error: 'Invalid TP/SL price.' })),
    );
    await expect(executor.placeStop(stop)).resolves.toMatchObject({
      status: 'REJECTED',
      error: 'Invalid TP/SL price.',
    });
  });

  it('cancels a stop by cloid and tells when it was already gone', async () => {
    const { executor, exchange } = createExecutor();
    exchange.cancelByCloid.mockResolvedValueOnce({ status: 'ok' });
    await expect(executor.cancelOrder('ETH', CLOID)).resolves.toBe(true);
    expect(exchange.cancelByCloid).toHaveBeenCalledWith({
      cancels: [{ asset: 1, cloid: CLOID }],
    });
    exchange.cancelByCloid.mockRejectedValueOnce(
      apiError({
        status: 'ok',
        response: {
          type: 'cancel',
          data: {
            statuses: [
              { error: 'Order was never placed, already canceled, or filled.' },
            ],
          },
        },
      }),
    );
    await expect(executor.cancelOrder('ETH', CLOID)).resolves.toBe(false);
  });

  it('lets other cancel failures reach the caller', async () => {
    const { executor, exchange } = createExecutor();
    exchange.cancelByCloid.mockRejectedValue(new Error('network down'));
    await expect(executor.cancelOrder('ETH', CLOID)).rejects.toThrow(
      'network down',
    );
  });
});
