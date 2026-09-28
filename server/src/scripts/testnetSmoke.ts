import { Logger } from '@nestjs/common';
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid';
import {
  HYPERLIQUID_URLS,
  HyperliquidInfoClient,
  normalizeAddress,
  WeightBudget,
} from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { floorOrderSize, roundLimitPrice } from '../copy/copySizing';
import { LiveExecutor, readAgentKey } from '../execution/liveExecutor';
import type { OrderRequest } from '../execution/types';
import { readMarkets } from '../market/marketData.service';

const COIN = 'ETH';
const WEIGHT_PER_MINUTE = 200;
const ORDER_EXPIRY_MS = 5_000;
const TAKER_FEE_BPS = 4.5;
const MAX_EXCHANGE_LEVERAGE = 5;
const OPEN_NOTIONAL_USD = 15;
const FAR_FROM_MARKET = 0.9;
const MARKETABLE_BAND = 0.01;
const FIRST_STOP_DISTANCE = 0.2;
const MOVED_STOP_DISTANCE = 0.15;
const EXIT_BAND = 0.03;

const environmentSchema = z.object({
  HYPERLIQUID_NETWORK: z.literal('testnet'),
  HYPERLIQUID_API_URL: z.url().optional(),
  HYPERLIQUID_ACCOUNT_ADDRESS: z.string().transform((value, context) => {
    const address = normalizeAddress(value);
    if (address === null) {
      context.addIssue({ code: 'custom', message: 'is not a 0x address' });
      return z.NEVER;
    }
    return address;
  }),
  HYPERLIQUID_AGENT_KEY_FILE: z.string().min(1),
});

type SmokeAnswer = {
  step: string;
  outcome: 'answered' | 'failed';
  detail: unknown;
};

const logger = new Logger('TestnetSmoke');

function newCloid(): string {
  return `0x${randomBytes(16).toString('hex')}`;
}

function toJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'bigint'
        ? entry.toString()
        : entry instanceof Decimal
          ? entry.toFixed()
          : entry,
    ),
  );
}

async function record(
  answers: SmokeAnswer[],
  step: string,
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    const detail = toJson(await action());
    answers.push({ step, outcome: 'answered', detail });
    logger.log(`${step}: ${JSON.stringify(detail)}`);
    return detail;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    answers.push({ step, outcome: 'failed', detail });
    logger.warn(`${step} failed: ${detail}`);
    return null;
  }
}

async function runTestnetSmoke(): Promise<void> {
  const parsed = environmentSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `The testnet smoke needs a testnet configuration\n${z.prettifyError(parsed.error)}`,
    );
  }
  const environment = parsed.data;
  const apiUrl =
    environment.HYPERLIQUID_API_URL ?? HYPERLIQUID_URLS.testnet.apiUrl;
  const account = environment.HYPERLIQUID_ACCOUNT_ADDRESS;
  const budget = new WeightBudget(WEIGHT_PER_MINUTE);
  const info = new HyperliquidInfoClient(apiUrl, budget);
  const agent = privateKeyToAccount(
    readAgentKey(environment.HYPERLIQUID_AGENT_KEY_FILE),
  );
  const exchange = new ExchangeClient({
    transport: new HttpTransport({ isTestnet: true, apiUrl }),
    wallet: agent,
    defaultExpiresAfter: () => Date.now() + ORDER_EXPIRY_MS,
  });
  const markets = readMarkets(await info.metaAndAssetCtxs());
  const market = markets.get(COIN);
  if (market === undefined) {
    throw new Error(`${COIN} is not listed on testnet`);
  }
  const executor = new LiveExecutor(
    exchange,
    info,
    budget,
    { readMarket: (coin) => markets.get(coin) ?? null },
    {
      accountAddress: account,
      agentAddress: agent.address.toLowerCase(),
      orderExpiryMs: ORDER_EXPIRY_MS,
      takerFeeBps: TAKER_FEE_BPS,
      maxExchangeLeverage: MAX_EXCHANGE_LEVERAGE,
    },
  );
  const answers: SmokeAnswer[] = [];
  const readTop = async () => {
    const book = (await info.l2Book(COIN)) as {
      levels: [{ px: string }[], { px: string }[]];
    };
    return {
      bid: new Decimal(book.levels[0][0].px),
      ask: new Decimal(book.levels[1][0].px),
    };
  };
  const price = (value: Decimal, isBuy: boolean) =>
    roundLimitPrice(value, market.szDecimals, isBuy);
  const order = (overrides: Partial<OrderRequest>): OrderRequest => ({
    cloid: newCloid(),
    coin: COIN,
    isBuy: true,
    size: new Decimal(0),
    limitPx: new Decimal(0),
    reduceOnly: false,
    heldSize: new Decimal(0),
    ...overrides,
  });
  const rawOrder = (request: OrderRequest, expiresAfter?: number) =>
    exchange.order(
      {
        orders: [
          {
            a: market.assetIndex,
            b: request.isBuy,
            p: request.limitPx.toFixed(),
            s: request.size.toFixed(),
            r: request.reduceOnly,
            t: { limit: { tif: 'Ioc' } },
            c: request.cloid,
          },
        ],
        grouping: 'na',
      },
      expiresAfter === undefined ? undefined : { expiresAfter },
    );

  await record(answers, 'boot_checks', async () => {
    await executor.verifyAccount();
    return 'standard account and an agent approved for it';
  });
  await record(answers, 'update_leverage', async () => {
    await executor.ensureLeverage(COIN);
    return `cross ${Math.min(market.maxLeverage, MAX_EXCHANGE_LEVERAGE)}x on ${COIN}`;
  });

  let top = await readTop();
  const farBuyPx = price(top.bid.mul(FAR_FROM_MARKET), true);
  const farSize = floorOrderSize(
    new Decimal(OPEN_NOTIONAL_USD).div(farBuyPx),
    market.szDecimals,
  );
  const farOrder = order({ size: farSize, limitPx: farBuyPx });
  await record(answers, 'ioc_far_from_market', () =>
    executor.execute(farOrder),
  );
  await record(answers, 'order_status_by_cloid', () =>
    info.orderStatus(account, farOrder.cloid),
  );
  const repeated = order({ size: farSize, limitPx: farBuyPx });
  await record(answers, 'cloid_first_use', () => rawOrder(repeated));
  await record(answers, 'cloid_second_use', () => rawOrder(repeated));
  await record(answers, 'expired_action', () =>
    rawOrder(
      order({ size: farSize, limitPx: farBuyPx }),
      Date.now() - ORDER_EXPIRY_MS,
    ),
  );

  top = await readTop();
  const openSize = floorOrderSize(
    new Decimal(OPEN_NOTIONAL_USD).div(top.ask),
    market.szDecimals,
  ).plus(new Decimal(1).div(10 ** market.szDecimals));
  const opened = await record(answers, 'open_small_position', () =>
    executor.execute(
      order({
        size: openSize,
        limitPx: price(top.ask.mul(1 + MARKETABLE_BAND), true),
      }),
    ),
  );
  const held = new Decimal(
    (opened as { filledSize?: string } | null)?.filledSize ?? 0,
  );
  if (held.isZero()) {
    await writeAnswers(answers);
    return;
  }
  const firstStop = newCloid();
  await record(answers, 'place_position_stop', () =>
    executor.placeStop({
      cloid: firstStop,
      coin: COIN,
      isLong: true,
      size: held,
      triggerPx: price(top.bid.mul(1 - FIRST_STOP_DISTANCE), false),
      limitPx: price(top.bid.mul(1 - FIRST_STOP_DISTANCE - EXIT_BAND), false),
    }),
  );
  const movedStop = newCloid();
  await record(answers, 'move_position_stop', () =>
    executor.placeStop({
      cloid: movedStop,
      coin: COIN,
      isLong: true,
      size: held,
      triggerPx: price(top.bid.mul(1 - MOVED_STOP_DISTANCE), false),
      limitPx: price(top.bid.mul(1 - MOVED_STOP_DISTANCE - EXIT_BAND), false),
    }),
  );
  await record(answers, 'first_stop_after_move', () =>
    info.orderStatus(account, firstStop),
  );
  await record(answers, 'cancel_first_stop', () =>
    executor.cancelOrder(COIN, firstStop),
  );

  top = await readTop();
  const exitPx = price(top.bid.mul(1 - EXIT_BAND), false);
  const half = floorOrderSize(held.div(2), market.szDecimals);
  const reduced = await record(answers, 'reduce_only_under_minimum', () =>
    executor.execute(
      order({
        isBuy: false,
        size: half,
        limitPx: exitPx,
        reduceOnly: true,
        heldSize: held,
      }),
    ),
  );
  const remaining = held.minus(
    new Decimal((reduced as { filledSize?: string } | null)?.filledSize ?? 0),
  );
  await record(answers, 'exact_close_under_minimum', () =>
    executor.execute(
      order({
        isBuy: false,
        size: remaining,
        limitPx: exitPx,
        reduceOnly: true,
        heldSize: remaining,
      }),
    ),
  );
  await record(answers, 'moved_stop_after_close', () =>
    info.orderStatus(account, movedStop),
  );
  await record(answers, 'cancel_moved_stop', () =>
    executor.cancelOrder(COIN, movedStop),
  );
  await writeAnswers(answers);
}

async function writeAnswers(answers: SmokeAnswer[]): Promise<void> {
  const directory = join(process.cwd(), 'reports');
  await mkdir(directory, { recursive: true });
  const path = join(
    directory,
    `testnet-smoke-${new Date().toISOString().slice(0, 10)}.json`,
  );
  await writeFile(path, `${JSON.stringify(answers, null, 2)}\n`);
  logger.log(`Wrote ${answers.length} answers to ${path}`);
}

runTestnetSmoke().catch((error) => {
  logger.error(
    'Testnet smoke stopped',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
