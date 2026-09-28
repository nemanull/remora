import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HyperliquidSocket, type HyperliquidWsFrame } from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { BookChains } from '../books/bookChains';
import { CopyPositionsService } from '../books/copyPositions.service';
import type { ServerConfig } from '../config';
import { CopyEvents } from '../copy/copyEvents';
import type { Order } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  closeReasonFor,
  ExecutionService,
  LIVE_EXECUTOR,
} from './execution.service';
import { LiveExecutor } from './liveExecutor';

const MAX_REMEMBERED_TIDS = 20_000;

const accountFillSchema = z.object({
  coin: z.string(),
  px: z.string(),
  sz: z.string(),
  side: z.enum(['A', 'B']),
  time: z.number(),
  oid: z.number(),
  tid: z.number(),
  fee: z.string(),
  cloid: z.string().nullish(),
});

const accountFillsSchema = z.object({
  isSnapshot: z.boolean().optional(),
  user: z.string(),
  fills: z.array(accountFillSchema),
});

export type AccountFill = z.infer<typeof accountFillSchema>;

export type OrderFills = {
  filledSize: Decimal;
  averagePrice: Decimal;
  feeUsd: Decimal;
  lastTime: Date;
};

export function summarizeOrderFills(fills: AccountFill[]): OrderFills | null {
  let filledSize = new Decimal(0);
  let notional = new Decimal(0);
  let feeUsd = new Decimal(0);
  let lastTime = 0;
  for (const fill of fills) {
    filledSize = filledSize.plus(fill.sz);
    notional = notional.plus(new Decimal(fill.sz).mul(fill.px));
    feeUsd = feeUsd.plus(fill.fee);
    lastTime = Math.max(lastTime, fill.time);
  }
  return filledSize.isZero()
    ? null
    : {
        filledSize,
        averagePrice: notional.div(filledSize),
        feeUsd,
        lastTime: new Date(lastTime),
      };
}

@Injectable()
export class AccountStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountStreamService.name);
  private readonly fillsByOid = new Map<number, AccountFill[]>();
  private readonly seenTids = new Set<number>();
  private socket: HyperliquidSocket | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chains: BookChains,
    private readonly positions: CopyPositionsService,
    private readonly execution: ExecutionService,
    private readonly events: CopyEvents,
    @Inject(LIVE_EXECUTOR) private readonly liveExecutor: LiveExecutor | null,
    private readonly config: ConfigService<ServerConfig, true>,
  ) {}

  onModuleInit(): void {
    if (this.liveExecutor === null) {
      return;
    }
    const account = this.liveExecutor.readAccountAddress();
    this.socket = new HyperliquidSocket({
      url: this.config.getOrThrow('HYPERLIQUID_WS_URL', { infer: true }),
      onFrame: (frame) => this.handleFrame(frame),
      onDisconnect: (reason, reconnectInMs) =>
        this.logger.warn(
          `Account fills socket dropped (${reason}), reconnecting in ${reconnectInMs} ms`,
        ),
    });
    this.socket.start();
    void this.socket
      .subscribe({ type: 'userFills', user: account })
      .then((result) => {
        if (result.error !== null && result.error !== 'socket_stopped') {
          this.logger.error(
            `Hyperliquid refused the userFills subscription of account ${account}: ${result.error}`,
          );
        }
      });
  }

  async onModuleDestroy(): Promise<void> {
    await this.socket?.stop();
  }

  handleFrame(frame: HyperliquidWsFrame): void {
    if (frame.channel !== 'userFills') {
      return;
    }
    const parsed = accountFillsSchema.safeParse(frame.data);
    if (!parsed.success) {
      this.logger.warn(
        'Dropped an account userFills frame that failed to parse',
      );
      return;
    }
    const isSnapshot = parsed.data.isSnapshot === true;
    const touchedOids = new Set<number>();
    for (const fill of parsed.data.fills) {
      if (this.seenTids.has(fill.tid)) {
        continue;
      }
      this.rememberTid(fill.tid);
      const fills = this.fillsByOid.get(fill.oid) ?? [];
      fills.push(fill);
      this.fillsByOid.set(fill.oid, fills);
      touchedOids.add(fill.oid);
    }
    for (const oid of touchedOids) {
      this.chains
        .run('MAIN', '', () => this.recordOrderFills(oid, isSnapshot))
        .catch((error) =>
          this.logger.error(
            `Failed to record account fills of order ${oid}`,
            error instanceof Error ? error.stack : String(error),
          ),
        );
    }
  }

  async recordOrderFills(oid: number, isSnapshot: boolean): Promise<void> {
    const fills = this.fillsByOid.get(oid) ?? [];
    const summary = summarizeOrderFills(fills);
    if (summary === null) {
      return;
    }
    const cloid = fills.find((fill) => fill.cloid)?.cloid ?? null;
    const order = await this.prisma.order.findFirst({
      where:
        cloid === null
          ? { exchangeOid: BigInt(oid) }
          : { OR: [{ cloid }, { exchangeOid: BigInt(oid) }] },
    });
    if (order === null) {
      this.fillsByOid.delete(oid);
      if (!isSnapshot) {
        this.alertUnknownFill(oid, fills);
      }
      return;
    }
    await this.applyOrderFills(order, oid, summary);
    if (summary.filledSize.gte(order.size.toString())) {
      this.fillsByOid.delete(oid);
    }
  }

  private async applyOrderFills(
    order: Order,
    oid: number,
    summary: OrderFills,
  ): Promise<void> {
    const appliedSize = new Decimal(order.filledSize.toString());
    const recordedFee = new Decimal(order.feeUsd.toString());
    const missingSize = summary.filledSize.minus(appliedSize);
    if (missingSize.lt(0)) {
      return;
    }
    const feeDelta = summary.feeUsd.minus(recordedFee);
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        filledSize: summary.filledSize.toFixed(),
        avgPx: summary.averagePrice.toFixed(),
        feeUsd: summary.feeUsd.toFixed(6),
        status: missingSize.gt(0)
          ? summary.filledSize.gte(order.size.toString())
            ? 'FILLED'
            : 'PARTIALLY_FILLED'
          : order.status,
        exchangeOid: order.exchangeOid ?? BigInt(oid),
      },
    });
    if (order.positionId === null) {
      return;
    }
    if (missingSize.isZero()) {
      await this.positions.adjustFees(order.positionId, feeDelta);
      return;
    }
    const copy = await this.positions.applyFill(order.positionId, {
      isBuy: order.isBuy,
      size: missingSize,
      price: summary.averagePrice,
      feeUsd: feeDelta,
      at: summary.lastTime,
    });
    this.logger.warn(
      `Account fills added ${missingSize.toFixed()} on ${order.coin} to order ${order.cloid} ${order.purpose}, which its result did not show`,
    );
    if (order.reduceOnly && new Decimal(copy.size.toString()).isZero()) {
      const decision =
        order.decisionId === null
          ? null
          : await this.prisma.copyDecision.findUnique({
              where: { id: order.decisionId },
              select: { action: true },
            });
      await this.execution.closeWithoutOrder(
        copy.id,
        closeReasonFor(order.purpose, decision?.action ?? null),
      );
      return;
    }
    this.positions.announceChange(copy, 'resized');
  }

  private alertUnknownFill(oid: number, fills: AccountFill[]): void {
    const [first] = fills;
    const message = `Account fill of order ${oid} on ${first.coin}, ${first.side === 'B' ? 'buy' : 'sell'} ${first.sz} at ${first.px}, matches no order of remora`;
    this.logger.error(message);
    this.events.publish({
      type: 'alert',
      code: 'unknown_account_fill',
      message,
      wallet: null,
      clusterId: null,
    });
  }

  private rememberTid(tid: number): void {
    this.seenTids.add(tid);
    if (this.seenTids.size > MAX_REMEMBERED_TIDS) {
      const [oldest] = this.seenTids;
      this.seenTids.delete(oldest);
    }
  }
}
