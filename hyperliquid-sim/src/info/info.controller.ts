import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { IpLimits, normalizeSourceAddress } from '../limits/ipLimits';
import { Simulation } from '../simulation';
import { readClearinghouseState } from '../traders/clearinghouseState';
import { emptyPortfolio } from '../traders/syntheticHistory';
import { FILL_HORIZON, FILLS_PAGE_LIMIT } from '../traders/syntheticTraders';
import { FaultInjection } from '../truth/faultInjection';

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase());
const time = z.number().int().nonnegative();
const candleInterval = z.enum([
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
]);

const infoRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('userFillsByTime'),
    user: address,
    startTime: time,
    endTime: time.nullish(),
    aggregateByTime: z.boolean().optional(),
  }),
  z.object({ type: z.literal('portfolio'), user: address }),
  z.object({
    type: z.literal('clearinghouseState'),
    user: address,
    dex: z.string().optional(),
  }),
  z.object({
    type: z.literal('l2Book'),
    coin: z.string(),
    nSigFigs: z.number().nullish(),
    mantissa: z.number().nullish(),
  }),
  z.object({ type: z.literal('allMids'), dex: z.string().optional() }),
  z.object({ type: z.literal('meta'), dex: z.string().optional() }),
  z.object({ type: z.literal('metaAndAssetCtxs') }),
  z.object({
    type: z.literal('candleSnapshot'),
    req: z.object({
      coin: z.string(),
      interval: candleInterval,
      startTime: time,
      endTime: time.optional(),
    }),
  }),
  z.object({
    type: z.literal('fundingHistory'),
    coin: z.string(),
    startTime: time,
    endTime: time.nullish(),
  }),
  z.object({
    type: z.literal('userNonFundingLedgerUpdates'),
    user: address,
    startTime: time,
    endTime: time.nullish(),
  }),
  z.object({
    type: z.literal('orderStatus'),
    user: address,
    oid: z.union([z.number().int(), z.string()]),
  }),
  z.object({ type: z.literal('userAbstraction'), user: address }),
  z.object({ type: z.literal('userRole'), user: address }),
]);

type InfoRequest = z.output<typeof infoRequestSchema>;
type InfoType = InfoRequest['type'];
type InfoAnswer = { body: unknown; status: number; items: number };

const BASE_WEIGHTS: Record<InfoType, number> = {
  l2Book: 2,
  allMids: 2,
  clearinghouseState: 2,
  orderStatus: 2,
  userRole: 60,
  userFillsByTime: 20,
  fundingHistory: 20,
  candleSnapshot: 20,
  portfolio: 20,
  meta: 20,
  metaAndAssetCtxs: 20,
  userNonFundingLedgerUpdates: 20,
  userAbstraction: 20,
};

const ITEMS_PER_EXTRA_WEIGHT: Partial<Record<InfoType, number>> = {
  userFillsByTime: 20,
  fundingHistory: 20,
  candleSnapshot: 60,
};

function answer(body: unknown, items = 0): InfoAnswer {
  return { body, status: 200, items };
}

@Controller()
export class InfoController {
  constructor(
    private readonly simulation: Simulation,
    private readonly limits: IpLimits,
    private readonly faults: FaultInjection,
  ) {}

  @Post('info')
  async handleInfo(
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!request.is('application/json')) {
      response
        .status(415)
        .type('text/plain')
        .send('Expected request with `Content-Type: application/json`');
      return;
    }
    const ip = normalizeSourceAddress(request.socket.remoteAddress);
    const fault = this.faults.readRestFault(ip, this.simulation.now());
    if (fault.delayMs > 0) {
      await sleep(fault.delayMs);
    }
    if (fault.status !== null) {
      response.status(fault.status).end();
      return;
    }
    const parsed = infoRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response
        .status(422)
        .type('text/plain')
        .send('Failed to deserialize the JSON body into the target type');
      return;
    }
    const now = this.simulation.now();
    if (!this.limits.admitWeight(ip, BASE_WEIGHTS[parsed.data.type], now)) {
      response.status(429).end();
      return;
    }
    const result = this.answerRequest(parsed.data, now);
    const itemsPerWeight = ITEMS_PER_EXTRA_WEIGHT[parsed.data.type];
    if (itemsPerWeight !== undefined) {
      this.limits.chargeWeight(
        ip,
        Math.floor(result.items / itemsPerWeight),
        now,
      );
    }
    response.status(result.status).json(result.body);
  }

  private answerRequest(request: InfoRequest, now: number): InfoAnswer {
    const { market, traders, history } = this.simulation;
    switch (request.type) {
      case 'userFillsByTime': {
        const wallet = this.simulation.findWallet(request.user);
        const visibleUntil = now - this.simulation.restLagMs;
        const endTime = Math.min(request.endTime ?? visibleUntil, visibleUntil);
        const fills = wallet
          ? traders
              .readRecentFills(
                wallet,
                request.startTime,
                visibleUntil,
                FILL_HORIZON,
              )
              .filter((fill) => fill.time <= endTime)
              .slice(0, FILLS_PAGE_LIMIT)
          : [];
        return answer(fills, fills.length);
      }
      case 'portfolio': {
        const wallet = this.simulation.findWallet(request.user);
        return answer(
          wallet ? history.readPortfolio(wallet, now) : emptyPortfolio(),
        );
      }
      case 'clearinghouseState':
        return answer(
          readClearinghouseState(
            this.simulation,
            request.user,
            request.dex ?? '',
            now,
          ),
        );
      case 'l2Book':
        return market.findCoin(request.coin)
          ? answer(market.readBook(request.coin, now))
          : { body: null, status: 500, items: 0 };
      case 'allMids':
        return answer(market.readMids(now));
      case 'meta':
        return answer(this.readMeta());
      case 'metaAndAssetCtxs':
        return answer([this.readMeta(), market.readContexts(now)]);
      case 'candleSnapshot': {
        const { coin, interval, startTime, endTime } = request.req;
        const candles = market.findCoin(coin)
          ? market.readCandles(coin, interval, startTime, endTime ?? now, now)
          : [];
        return answer(candles, candles.length);
      }
      case 'fundingHistory': {
        const items = market.findCoin(request.coin)
          ? market.readFundingHistory(
              request.coin,
              request.startTime,
              Math.min(request.endTime ?? now, now),
            )
          : [];
        return answer(items, items.length);
      }
      case 'userNonFundingLedgerUpdates': {
        const wallet = this.simulation.findWallet(request.user);
        return answer(
          wallet
            ? traders.readLedgerUpdates(
                wallet,
                request.startTime,
                Math.min(request.endTime ?? now, now),
              )
            : [],
        );
      }
      case 'orderStatus':
        return answer({ status: 'unknownOid' });
      case 'userAbstraction':
        return answer('default');
      case 'userRole': {
        const wallet = this.simulation.findWallet(request.user);
        if (!wallet) {
          return answer({ role: 'missing' });
        }
        return answer({ role: wallet.vaultName === null ? 'user' : 'vault' });
      }
    }
  }

  private readMeta() {
    const universe = this.simulation.market.readUniverse();
    const leverages = [...new Set(universe.map((asset) => asset.maxLeverage))];
    return {
      universe,
      marginTables: leverages.map((maxLeverage) => [
        maxLeverage,
        {
          description: '',
          marginTiers: [{ lowerBound: '0.0', maxLeverage }],
        },
      ]),
      collateralToken: 0,
    };
  }
}
