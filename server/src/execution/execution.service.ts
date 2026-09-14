import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import type { Subscription } from 'rxjs';
import { BookChains } from '../books/bookChains';
import { BookStateService } from '../books/bookState.service';
import { CopyPositionsService } from '../books/copyPositions.service';
import { LiveAccountService } from '../books/liveAccount.service';
import {
  PaperStopsService,
  type StopTrigger,
} from '../books/paperStops.service';
import type { ServerConfig } from '../config';
import { buildCloseIntent } from '../copy/copyEngine';
import { CopyEvents } from '../copy/copyEvents';
import { limitPrice, stopPrice } from '../copy/copySizing';
import type {
  BookName,
  CopyAction,
  LeaderSizeSync,
  NewCopy,
  OrderIntent,
  OrderPurpose,
} from '../copy/types';
import type { CopyPosition, Order } from '../generated/prisma/client';
import { MarketDataService } from '../market/marketData.service';
import { PrismaService } from '../prisma/prisma.service';
import { cloidForOrder } from './cloid';
import { LiveExecutor } from './liveExecutor';
import { OrdersService } from './orders.service';
import { PaperExecutor } from './paperExecutor';
import type { ExecutionResult, Executor } from './types';

export const LIVE_EXECUTOR = 'LIVE_EXECUTOR';

export const MAX_EXIT_ATTEMPTS = 5;
export const MARKET_DELISTED = 'market_delisted';
const EXIT_RETRY_BASE_MS = 1_000;
const LIVE_LEVERAGE_LOOKBACK_MS = 30 * 86_400_000;

export type EntryRequest = {
  intent: OrderIntent;
  decisionId: bigint;
  opensCopy: NewCopy | null;
  leaderSizeSync: LeaderSizeSync | null;
  decidedAt: Date;
};

export type ExitRequest = {
  intent: OrderIntent;
  decisionId: bigint;
  closeReason: string | null;
  leaderSizeSync: LeaderSizeSync | null;
};

export type CloseRequest = {
  book: BookName;
  copyId: bigint;
  purpose: 'STOP' | 'RECONCILE';
  reason: string;
  referencePx: Decimal | null;
};

type ExitPlan = {
  book: BookName;
  wallet: string;
  coin: string;
  copyId: bigint;
  purpose: OrderPurpose;
  decisionId: bigint | null;
  attempt: number;
  firstAttempt: number;
  closeReason: string | null;
  referencePx: Decimal;
  leaderSizeSync: LeaderSizeSync | null;
};

export function closeReasonFor(
  purpose: OrderPurpose,
  action: CopyAction | null,
): string {
  if (purpose === 'STOP') {
    return 'stop_loss';
  }
  if (purpose === 'RECONCILE') {
    return 'leader_flat';
  }
  return action === 'FLIP' ? 'leader_flipped' : 'leader_closed';
}

function toDecimal(value: { toString(): string }): Decimal {
  return new Decimal(value.toString());
}

function hasFill(
  result: ExecutionResult,
): result is ExecutionResult & { averagePrice: Decimal } {
  return result.filledSize.gt(0) && result.averagePrice !== null;
}

@Injectable()
export class ExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionService.name);
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private readonly exitSlippageBps: number;
  private readonly stopLossShare: number;
  private readonly stopMaxDistance: number;
  private triggerSubscription: Subscription | undefined;

  constructor(
    private readonly chains: BookChains,
    private readonly orders: OrdersService,
    private readonly positions: CopyPositionsService,
    private readonly bookState: BookStateService,
    private readonly paperStops: PaperStopsService,
    private readonly paperExecutor: PaperExecutor,
    @Inject(LIVE_EXECUTOR) private readonly liveExecutor: LiveExecutor | null,
    private readonly liveAccount: LiveAccountService,
    private readonly market: MarketDataService,
    private readonly prisma: PrismaService,
    private readonly events: CopyEvents,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.exitSlippageBps = config.getOrThrow('EXIT_SLIPPAGE_BPS', {
      infer: true,
    });
    this.stopLossShare = config.getOrThrow('STOP_LOSS_ALLOCATION_SHARE', {
      infer: true,
    });
    this.stopMaxDistance = config.getOrThrow('STOP_MAX_DISTANCE', {
      infer: true,
    });
  }

  async onModuleInit(): Promise<void> {
    this.triggerSubscription = this.paperStops.triggers$.subscribe((trigger) =>
      this.closeOnStop(trigger),
    );
    if (this.liveExecutor !== null) {
      await this.setRecentLiveLeverage(this.liveExecutor);
    }
  }

  onModuleDestroy(): void {
    this.triggerSubscription?.unsubscribe();
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  readExecutor(book: BookName): Executor {
    return book === 'MAIN' && this.liveExecutor !== null
      ? this.liveExecutor
      : this.paperExecutor;
  }

  async executeEntry(request: EntryRequest): Promise<void> {
    const { intent } = request;
    let copyId = intent.copyId;
    const isNewCopy = copyId === null;
    if (copyId === null) {
      if (request.opensCopy === null) {
        throw new Error(
          `Entry of decision ${request.decisionId} names neither a copy nor a new copy`,
        );
      }
      copyId = (
        await this.positions.createCopy(request.opensCopy, request.decidedAt)
      ).id;
    }
    const cloid = cloidForOrder({
      decisionId: request.decisionId,
      positionId: null,
      purpose: 'ENTRY',
      attempt: 1,
    });
    const order = await this.orders.createOrder({
      book: intent.book,
      decisionId: request.decisionId,
      positionId: copyId,
      cloid,
      coin: intent.coin,
      isBuy: intent.isBuy,
      size: intent.size,
      limitPx: intent.limitPx,
      reduceOnly: false,
      purpose: 'ENTRY',
      attempt: 1,
      submittedAt: new Date(),
    });
    const result = await this.readExecutor(intent.book).execute({
      cloid,
      coin: intent.coin,
      isBuy: intent.isBuy,
      size: intent.size,
      limitPx: intent.limitPx,
      reduceOnly: false,
      heldSize: new Decimal(0),
    });
    await this.orders.recordResult(order, result, intent.referencePx);
    await this.refreshLiveAccount(intent.book);
    if (hasFill(result)) {
      const copy = await this.positions.applyFill(copyId, {
        isBuy: intent.isBuy,
        size: result.filledSize,
        price: result.averagePrice,
        feeUsd: result.feeUsd,
        at: result.acknowledgedAt ?? new Date(),
      });
      if (request.leaderSizeSync?.waitsForFill === true) {
        await this.positions.syncLeaderSize(
          copyId,
          request.leaderSizeSync.leaderSizeAtSync,
        );
      }
      this.positions.announceChange(copy, isNewCopy ? 'opened' : 'resized');
      await this.protectCopy(copy);
      return;
    }
    if (!isNewCopy) {
      return;
    }
    if (result.status === 'UNKNOWN') {
      this.logger.warn(
        `Entry ${cloid} of copy ${copyId} on ${intent.coin} is unresolved, so the copy stays open at size 0 for reconciliation`,
      );
      return;
    }
    await this.positions.deleteCopy(copyId);
  }

  async executeExit(request: ExitRequest): Promise<boolean> {
    const { intent } = request;
    if (intent.copyId === null) {
      throw new Error(`Exit of decision ${request.decisionId} has no copy`);
    }
    return this.runExit(
      {
        book: intent.book,
        wallet: intent.wallet,
        coin: intent.coin,
        copyId: intent.copyId,
        purpose: intent.purpose,
        decisionId: request.decisionId,
        attempt: 1,
        firstAttempt: 1,
        closeReason: request.closeReason,
        referencePx: intent.referencePx,
        leaderSizeSync: request.leaderSizeSync,
      },
      intent,
    );
  }

  async closeCopy(request: CloseRequest): Promise<boolean> {
    const copy = await this.bookState.readCopyView(request.copyId);
    if (copy === null) {
      return true;
    }
    if (copy.size.isZero()) {
      await this.closeWithoutOrder(request.copyId, request.reason);
      return true;
    }
    const market = this.bookState.readMarketView(copy.coin);
    const referencePx =
      request.referencePx ?? this.bookState.readMark(copy.coin);
    if (market === null || referencePx === null) {
      this.logger.error(
        `Copy ${copy.id} on ${copy.coin} cannot be closed for ${request.reason}, because ${copy.coin} has no market or price`,
      );
      return false;
    }
    const attempt = await this.orders.readNextAttempt(copy.id, request.purpose);
    const intent = buildCloseIntent({
      book: request.book,
      copy,
      purpose: request.purpose,
      market,
      referencePx,
      exitSlippageBps: this.exitSlippageBps,
    });
    if (intent === null) {
      await this.closeWithoutOrder(copy.id, request.reason);
      return true;
    }
    return this.runExit(
      {
        book: request.book,
        wallet: copy.wallet,
        coin: copy.coin,
        copyId: copy.id,
        purpose: request.purpose,
        decisionId: null,
        attempt,
        firstAttempt: attempt,
        closeReason: request.reason,
        referencePx,
        leaderSizeSync: null,
      },
      intent,
    );
  }

  async settleDelistedCopy(
    book: BookName,
    copyId: bigint,
    lastMid: Decimal | null,
  ): Promise<void> {
    const copy = await this.prisma.copyPosition.findUnique({
      where: { id: copyId },
    });
    if (copy === null || !copy.isOpen) {
      return;
    }
    const heldSize = toDecimal(copy.size);
    const settlementPx =
      lastMid ?? (copy.entryPx === null ? null : toDecimal(copy.entryPx));
    if (!heldSize.isZero() && settlementPx !== null) {
      const isBuy = heldSize.isNegative();
      const size = heldSize.abs();
      const attempt = await this.orders.readNextAttempt(copyId, 'RECONCILE');
      const settledAt = new Date();
      const order = await this.orders.createOrder({
        book,
        decisionId: null,
        positionId: copyId,
        cloid: cloidForOrder({
          decisionId: null,
          positionId: copyId,
          purpose: 'RECONCILE',
          attempt,
        }),
        coin: copy.coin,
        isBuy,
        size,
        limitPx: settlementPx,
        reduceOnly: true,
        purpose: 'RECONCILE',
        attempt,
        submittedAt: settledAt,
      });
      await this.orders.recordResult(
        order,
        {
          status: 'FILLED',
          filledSize: size,
          averagePrice: settlementPx,
          feeUsd: new Decimal(0),
          exchangeOid: null,
          error: null,
          acknowledgedAt: settledAt,
        },
        settlementPx,
      );
      await this.positions.applyFill(copyId, {
        isBuy,
        size,
        price: settlementPx,
        feeUsd: new Decimal(0),
        at: settledAt,
      });
    }
    await this.closeWithoutOrder(copyId, MARKET_DELISTED);
  }

  async closeWithoutOrder(copyId: bigint, reason: string): Promise<void> {
    const copy = await this.positions.closeCopy(copyId, reason, new Date());
    this.paperStops.untrackStop(copyId);
    if (copy.book === 'MAIN' && this.liveExecutor !== null) {
      await this.cancelRestingStops(copy.id, this.liveExecutor);
    }
  }

  async protectCopy(copy: CopyPosition): Promise<void> {
    const market = this.market.readMarket(copy.coin);
    const size = toDecimal(copy.size);
    if (market === null || copy.entryPx === null || size.isZero()) {
      return;
    }
    const stopPx = stopPrice({
      size,
      entryPx: toDecimal(copy.entryPx),
      allocationUsd: toDecimal(copy.allocationUsd),
      lossShare: this.stopLossShare,
      maxDistance: this.stopMaxDistance,
      szDecimals: market.szDecimals,
    });
    if (stopPx === null) {
      return;
    }
    const protectedCopy = await this.positions.setStopPrice(copy.id, stopPx);
    if (this.paperStops.isPaperBook(copy.book) || this.liveExecutor === null) {
      this.paperStops.trackStop(protectedCopy);
      return;
    }
    await this.placeLiveStop(copy, size, stopPx, this.liveExecutor);
  }

  private async runExit(plan: ExitPlan, intent: OrderIntent): Promise<boolean> {
    const view = await this.bookState.readCopyView(plan.copyId);
    if (view === null) {
      return true;
    }
    const cloid = cloidForOrder({
      decisionId: plan.decisionId,
      positionId: plan.decisionId === null ? plan.copyId : null,
      purpose: plan.purpose,
      attempt: plan.attempt,
    });
    const order = await this.orders.createOrder({
      book: plan.book,
      decisionId: plan.decisionId,
      positionId: plan.copyId,
      cloid,
      coin: plan.coin,
      isBuy: intent.isBuy,
      size: intent.size,
      limitPx: intent.limitPx,
      reduceOnly: true,
      purpose: plan.purpose,
      attempt: plan.attempt,
      submittedAt: new Date(),
    });
    const result = await this.readExecutor(plan.book).execute({
      cloid,
      coin: plan.coin,
      isBuy: intent.isBuy,
      size: intent.size,
      limitPx: intent.limitPx,
      reduceOnly: true,
      heldSize: view.size.abs(),
    });
    await this.orders.recordResult(order, result, plan.referencePx);
    let copy: CopyPosition | null = null;
    if (hasFill(result)) {
      copy = await this.positions.applyFill(plan.copyId, {
        isBuy: intent.isBuy,
        size: result.filledSize,
        price: result.averagePrice,
        feeUsd: result.feeUsd,
        at: result.acknowledgedAt ?? new Date(),
      });
      if (plan.leaderSizeSync?.waitsForFill === true) {
        await this.positions.syncLeaderSize(
          plan.copyId,
          plan.leaderSizeSync.leaderSizeAtSync,
        );
      }
    }
    await this.refreshLiveAccount(plan.book);
    const remaining = copy === null ? view.size : toDecimal(copy.size);
    if (plan.closeReason !== null && remaining.isZero()) {
      await this.closeWithoutOrder(plan.copyId, plan.closeReason);
      return true;
    }
    if (copy !== null) {
      this.positions.announceChange(copy, 'resized');
    }
    if (plan.closeReason !== null) {
      this.scheduleExitRetry(plan);
    }
    return remaining.isZero();
  }

  private scheduleExitRetry(plan: ExitPlan): void {
    const tries = plan.attempt - plan.firstAttempt + 1;
    if (tries >= MAX_EXIT_ATTEMPTS) {
      this.logger.error(
        `Exit of copy ${plan.copyId} on ${plan.coin} in the ${plan.book} book is still open after ${tries} attempts, reconciliation keeps trying`,
      );
      this.events.publish({
        type: 'alert',
        code: 'exit_retries_exhausted',
        message: `Copy ${plan.copyId} of ${plan.wallet} on ${plan.coin} in the ${plan.book} book is still open after ${tries} exit attempts`,
        wallet: plan.wallet,
        clusterId: null,
      });
      void this.restorePaperStop(plan.copyId);
      return;
    }
    const delayMs = EXIT_RETRY_BASE_MS * 2 ** (tries - 1);
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      this.chains
        .run(plan.book, plan.wallet, () =>
          this.retryExit({ ...plan, attempt: plan.attempt + 1 }),
        )
        .catch((error) =>
          this.logger.error(
            `Exit retry of copy ${plan.copyId} on ${plan.coin} failed`,
            error instanceof Error ? error.stack : String(error),
          ),
        );
    }, delayMs);
    this.retryTimers.add(timer);
  }

  private async retryExit(plan: ExitPlan): Promise<void> {
    const copy = await this.bookState.readCopyView(plan.copyId);
    if (copy === null) {
      return;
    }
    const closeReason = plan.closeReason ?? 'leader_closed';
    if (copy.size.isZero()) {
      await this.closeWithoutOrder(copy.id, closeReason);
      return;
    }
    const market = this.bookState.readMarketView(copy.coin);
    if (market === null) {
      this.logger.error(
        `Exit retry of copy ${copy.id} cannot price ${copy.coin}, which left the live meta`,
      );
      this.scheduleExitRetry(plan);
      return;
    }
    const intent = buildCloseIntent({
      book: plan.book,
      copy,
      purpose: plan.purpose,
      market,
      referencePx: plan.referencePx,
      exitSlippageBps: this.exitSlippageBps,
    });
    if (intent === null) {
      await this.closeWithoutOrder(copy.id, closeReason);
      return;
    }
    this.logger.log(
      `Retrying the exit of copy ${copy.id} on ${copy.coin}, attempt ${plan.attempt}`,
    );
    await this.runExit({ ...plan, closeReason }, intent);
  }

  private closeOnStop(trigger: StopTrigger): void {
    this.chains
      .run(trigger.book, trigger.wallet, () =>
        this.closeCopy({
          book: trigger.book,
          copyId: trigger.copyId,
          purpose: 'STOP',
          reason: 'stop_loss',
          referencePx: trigger.stopPx,
        }),
      )
      .catch((error) =>
        this.logger.error(
          `Paper stop of copy ${trigger.copyId} on ${trigger.coin} failed to close it`,
          error instanceof Error ? error.stack : String(error),
        ),
      );
  }

  private async restorePaperStop(copyId: bigint): Promise<void> {
    try {
      const copy = await this.prisma.copyPosition.findUnique({
        where: { id: copyId },
      });
      if (copy !== null) {
        this.paperStops.trackStop(copy);
      }
    } catch (error) {
      this.logger.error(
        `Failed to restore the paper stop of copy ${copyId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async placeLiveStop(
    copy: CopyPosition,
    size: Decimal,
    stopPx: Decimal,
    liveExecutor: LiveExecutor,
  ): Promise<void> {
    const market = this.market.readMarket(copy.coin);
    if (market === null) {
      return;
    }
    const previous = await this.orders.readRestingStops(copy.id);
    const attempt = await this.orders.readNextAttempt(copy.id, 'STOP');
    const cloid = cloidForOrder({
      decisionId: null,
      positionId: copy.id,
      purpose: 'STOP',
      attempt,
    });
    const isLong = size.isPositive();
    const limitPx = limitPrice(
      stopPx,
      !isLong,
      this.exitSlippageBps,
      market.szDecimals,
    );
    const order = await this.orders.createOrder({
      book: copy.book,
      decisionId: null,
      positionId: copy.id,
      cloid,
      coin: copy.coin,
      isBuy: !isLong,
      size: size.abs(),
      limitPx,
      reduceOnly: true,
      purpose: 'STOP',
      attempt,
      submittedAt: new Date(),
    });
    const placement = await liveExecutor.placeStop({
      cloid,
      coin: copy.coin,
      isLong,
      size: size.abs(),
      triggerPx: stopPx,
      limitPx,
    });
    await this.orders.recordStatus(order, placement.status, {
      exchangeOid: placement.exchangeOid,
      error: placement.error,
      acknowledgedAt: placement.acknowledgedAt,
    });
    if (placement.status !== 'SUBMITTED') {
      return;
    }
    for (const stop of previous) {
      await this.cancelStop(stop, liveExecutor);
    }
  }

  private async cancelRestingStops(
    copyId: bigint,
    liveExecutor: LiveExecutor,
  ): Promise<void> {
    for (const stop of await this.orders.readRestingStops(copyId)) {
      await this.cancelStop(stop, liveExecutor);
    }
  }

  private async cancelStop(
    stop: Order,
    liveExecutor: LiveExecutor,
  ): Promise<void> {
    try {
      const wasResting = await liveExecutor.cancelOrder(stop.coin, stop.cloid);
      await this.orders.recordStatus(stop, 'UNFILLED', {
        error: wasResting ? 'cancelled' : 'already_gone',
      });
    } catch (error) {
      this.logger.warn(
        `Failed to cancel stop ${stop.cloid} on ${stop.coin}, the next boot resolves it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async refreshLiveAccount(book: BookName): Promise<void> {
    if (book !== 'MAIN' || this.liveExecutor === null) {
      return;
    }
    try {
      await this.liveAccount.refreshAccount();
    } catch (error) {
      this.logger.warn(
        `Failed to refresh the live account after an order: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async setRecentLiveLeverage(
    liveExecutor: LiveExecutor,
  ): Promise<void> {
    const fills = await this.prisma.leaderFill.findMany({
      where: {
        time: { gte: new Date(Date.now() - LIVE_LEVERAGE_LOOKBACK_MS) },
        wallet: { status: 'LIVE' },
      },
      distinct: ['coin'],
      select: { coin: true },
    });
    for (const { coin } of fills) {
      try {
        await liveExecutor.ensureLeverage(coin);
      } catch (error) {
        this.logger.warn(
          `Failed to set cross leverage on ${coin} at boot, it is set before the first entry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.logger.log(
      `Set cross leverage at boot on ${fills.length} coins traded by LIVE leaders`,
    );
  }
}
