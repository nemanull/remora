import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import type { HyperliquidFill } from '@remora/sdk';
import { z } from 'zod';
import {
  IpLimits,
  type AddressUsageSummary,
  type LimitName,
  type LimitRefusal,
} from '../limits/ipLimits';
import { Simulation } from '../simulation';
import type { TraderProfileName } from '../traders/traderProfiles';
import { formatLots, formatPrice } from '../wireFormat';
import { SimSocketService } from '../ws/simSocket.service';
import { FaultInjection } from './faultInjection';

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase());
const time = z.coerce.number().int().nonnegative();

const fillsQuerySchema = z.object({
  wallet: address,
  since: time.default(0),
  until: time.optional(),
});

const positionsQuerySchema = z.object({
  wallet: address.optional(),
  at: time.optional(),
});

const refusalsQuerySchema = z.object({ since: time.default(0) });

const faultSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('drop_sockets'),
    ip: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('stall_pushes'),
    durationMs: z.number().int().positive(),
    ip: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('rest_status'),
    status: z.number().int().min(400).max(599).default(429),
    durationMs: z.number().int().positive(),
    ip: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('rest_delay'),
    delayMs: z.number().int().positive(),
    durationMs: z.number().int().positive(),
    ip: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('clear') }),
]);

export type SimWalletTruth = {
  address: string;
  profile: TraderProfileName;
  hasEdge: boolean;
  skill: number;
  dailyDrift: number;
  dailyVolatility: number;
  isVault: boolean;
  createdAt: number;
  coins: string[];
};

export type SimPositionTruth = {
  wallet: string;
  coin: string;
  szi: string;
  entryPx: string;
};

function parseQuery<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      reason: 'invalid_query',
      detail: z.prettifyError(result.error),
    });
  }
  return result.data;
}

@Controller('sim')
export class TruthController {
  constructor(
    private readonly simulation: Simulation,
    private readonly limits: IpLimits,
    private readonly faults: FaultInjection,
    private readonly sockets: SimSocketService,
  ) {}

  @Get('wallets')
  readWallets(): SimWalletTruth[] {
    return this.simulation.wallets.map((wallet) => ({
      address: wallet.address,
      profile: wallet.profile.name,
      hasEdge: wallet.hasEdge,
      skill: wallet.skill,
      dailyDrift: wallet.dailyDrift,
      dailyVolatility: wallet.dailyVolatility,
      isVault: wallet.vaultName !== null,
      createdAt: wallet.createdAt,
      coins: wallet.laneCoins.flat(),
    }));
  }

  @Get('fills')
  readFills(@Query() query: unknown): {
    wallet: string;
    since: number;
    until: number;
    fills: HyperliquidFill[];
  } {
    const {
      wallet: walletAddress,
      since,
      until,
    } = parseQuery(fillsQuerySchema, query);
    const wallet = this.simulation.findWallet(walletAddress);
    if (!wallet) {
      throw new NotFoundException({ reason: 'unknown_wallet' });
    }
    const end = Math.min(
      until ?? Number.MAX_SAFE_INTEGER,
      this.simulation.now(),
    );
    return {
      wallet: wallet.address,
      since,
      until: end,
      fills: this.simulation.traders.readFillsBetween(wallet, since, end),
    };
  }

  @Get('positions')
  readPositions(@Query() query: unknown): {
    at: number;
    positions: SimPositionTruth[];
  } {
    const { wallet: walletAddress, at } = parseQuery(
      positionsQuerySchema,
      query,
    );
    const time = Math.min(at ?? Number.MAX_SAFE_INTEGER, this.simulation.now());
    const wallets =
      walletAddress === undefined
        ? this.simulation.wallets
        : this.simulation.wallets.filter(
            (wallet) => wallet.address === walletAddress,
          );
    return {
      at: time,
      positions: wallets.flatMap((wallet) =>
        this.simulation.traders.readPositions(wallet, time).map((position) => ({
          wallet: position.wallet,
          coin: position.coin,
          szi: formatLots(position.lots, position.szDecimals),
          entryPx: formatPrice(position.entryPx, position.szDecimals),
        })),
      ),
    };
  }

  @Get('connections')
  readConnections(): {
    at: number;
    addresses: (AddressUsageSummary & { userFillsSubscribers: string[] })[];
  } {
    const now = this.simulation.now();
    const usersByIp = this.sockets.readSubscribedUsers();
    return {
      at: now,
      addresses: this.limits.summarizeUsage(now).map((usage) => ({
        ...usage,
        userFillsSubscribers: usersByIp.get(usage.ip) ?? [],
      })),
    };
  }

  @Get('refusals')
  readRefusals(@Query() query: unknown): {
    counts: Record<LimitName, number>;
    refusals: LimitRefusal[];
  } {
    const { since } = parseQuery(refusalsQuerySchema, query);
    return {
      counts: this.limits.readRefusalCounts(),
      refusals: this.limits.readRefusals(since),
    };
  }

  @Post('faults')
  @HttpCode(200)
  applyFault(@Body() body: unknown): {
    applied: string;
    droppedSockets?: number;
  } {
    const fault = parseQuery(faultSchema, body);
    const now = this.simulation.now();
    switch (fault.type) {
      case 'drop_sockets':
        return {
          applied: fault.type,
          droppedSockets: this.sockets.dropConnections(fault.ip ?? null),
        };
      case 'stall_pushes':
        this.faults.stallPushes(fault.durationMs, fault.ip ?? null, now);
        return { applied: fault.type };
      case 'rest_status':
        this.faults.answerRestWith(
          fault.status,
          fault.durationMs,
          fault.ip ?? null,
          now,
        );
        return { applied: fault.type };
      case 'rest_delay':
        this.faults.delayRest(
          fault.delayMs,
          fault.durationMs,
          fault.ip ?? null,
          now,
        );
        return { applied: fault.type };
      case 'clear':
        this.faults.clear();
        return { applied: fault.type };
    }
  }
}
