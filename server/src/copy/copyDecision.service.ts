import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Decimal } from 'decimal.js';
import { BookChains } from '../books/bookChains';
import { BookStateService } from '../books/bookState.service';
import { CopyPositionsService } from '../books/copyPositions.service';
import { KillSwitchService } from '../books/killSwitch.service';
import type { ServerConfig } from '../config';
import {
  closeReasonFor,
  ExecutionService,
} from '../execution/execution.service';
import {
  type CopyDecision,
  type CopyPosition,
  Prisma,
} from '../generated/prisma/client';
import { MetricsService } from '../metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { decide } from './copyEngine';
import { CopyEvents } from './copyEvents';
import { POLICY_ORDER } from './copyPolicies';
import {
  buildCoinSignal,
  type SignalFill,
  STORED_FILL_SELECT,
  type StoredFill,
  toSignalFill,
} from './signalBuilder';
import type {
  BookName,
  CopyAction,
  CopySettings,
  Decision,
  LeaderView,
  Signal,
  TraceLine,
} from './types';

const OUT_OF_ORDER = 'out_of_order';
const UNIQUE_VIOLATION = 'P2002';

type StoredDecision = {
  row: CopyDecision;
  deferredCopy: CopyPosition | null;
};

export function readCopySettingsFromConfig(
  config: ConfigService<ServerConfig, true>,
): CopySettings {
  return {
    liveAllocationUsd: new Decimal(
      config.getOrThrow('LIVE_ALLOCATION_USD', { infer: true }),
    ),
    shadowAllocationUsd: new Decimal(
      config.getOrThrow('SHADOW_ALLOCATION_USD', { infer: true }),
    ),
    signalMaxAgeMs: config.getOrThrow('SIGNAL_MAX_AGE_MS', { infer: true }),
    driftLimitMajorBps: config.getOrThrow('DRIFT_LIMIT_MAJOR_BPS', {
      infer: true,
    }),
    driftLimitOtherBps: config.getOrThrow('DRIFT_LIMIT_OTHER_BPS', {
      infer: true,
    }),
    exitSlippageBps: config.getOrThrow('EXIT_SLIPPAGE_BPS', { infer: true }),
    leaderEquityMaxAgeMs: config.getOrThrow('LEADER_EQUITY_MAX_AGE_MS', {
      infer: true,
    }),
    positionCapMultiple: config.getOrThrow('POSITION_CAP_MULTIPLE', {
      infer: true,
    }),
    grossExposureMultiple: config.getOrThrow('GROSS_EXPOSURE_MULTIPLE', {
      infer: true,
    }),
    maxOpenCopies: config.getOrThrow('MAX_OPEN_COPIES', { infer: true }),
    marginBuffer: config.getOrThrow('MARGIN_BUFFER', { infer: true }),
    dailyLossLimit: config.getOrThrow('DAILY_LOSS_LIMIT', { infer: true }),
    maxExchangeLeverage: config.getOrThrow('MAX_EXCHANGE_LEVERAGE', {
      infer: true,
    }),
  };
}

export function classifyLeaderMove(signal: Signal): CopyAction | null {
  const before = signal.positionBefore;
  const after = signal.positionAfter;
  if (before.equals(after) && !signal.touchedZero) {
    return null;
  }
  if (after.isZero()) {
    return 'CLOSE';
  }
  if (before.isZero()) {
    return 'OPEN';
  }
  if (signal.touchedZero || before.isPositive() !== after.isPositive()) {
    return 'FLIP';
  }
  return after.abs().gt(before.abs()) ? 'INCREASE' : 'REDUCE';
}

export function buildOutOfOrderTrace(detail: string): TraceLine[] {
  return POLICY_ORDER.map((policy) =>
    policy === 'episode'
      ? { policy, outcome: 'reject', reason: OUT_OF_ORDER, detail }
      : {
          policy,
          outcome: 'skip',
          reason: null,
          detail: 'not evaluated for an out-of-order signal',
        },
  );
}

function orderByIds(fills: StoredFill[], fillIds: bigint[]): StoredFill[] {
  const positions = new Map(fillIds.map((id, index) => [id, index]));
  return [...fills].sort(
    (left, right) =>
      (positions.get(left.id) ?? 0) - (positions.get(right.id) ?? 0),
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === UNIQUE_VIOLATION
  );
}

@Injectable()
export class CopyDecisionService {
  private readonly logger = new Logger(CopyDecisionService.name);
  private readonly settings: CopySettings;
  private readonly inFlightFills = new Set<bigint>();
  private readonly inFlightBooks = new Map<string, Map<BookName, number>>();
  private readonly completions = new Set<Promise<void>>();
  private routing: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly chains: BookChains,
    private readonly bookState: BookStateService,
    private readonly positions: CopyPositionsService,
    private readonly killSwitch: KillSwitchService,
    private readonly execution: ExecutionService,
    private readonly metrics: MetricsService,
    private readonly events: CopyEvents,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.settings = readCopySettingsFromConfig(config);
  }

  routeSignals(signals: Signal[]): void {
    for (const signal of signals) {
      this.routing = this.routing
        .then(() => this.routeSignal(signal))
        .catch((error) =>
          this.logger.error(
            `Failed to route signal ${signal.key}`,
            error instanceof Error ? error.stack : String(error),
          ),
        );
    }
  }

  async waitUntilIdle(): Promise<void> {
    for (;;) {
      await this.routing;
      await this.chains.drain();
      if (this.completions.size === 0) {
        return;
      }
      await Promise.all(this.completions);
    }
  }

  private async routeSignal(signal: Signal): Promise<void> {
    const freshFillIds = signal.fillIds.filter(
      (id) => !this.inFlightFills.has(id),
    );
    if (freshFillIds.length === 0) {
      this.logger.debug(
        `Signal ${signal.key} holds only fills already in flight`,
      );
      return;
    }
    const routed =
      freshFillIds.length === signal.fillIds.length
        ? signal
        : await this.rebuildSignal(signal, freshFillIds);
    if (routed === null) {
      return;
    }
    const books = await this.readTargetBooks(routed);
    for (const id of routed.fillIds) {
      this.inFlightFills.add(id);
    }
    this.countInFlight(routed, books, 1);
    const tasks = books.map((book) =>
      this.chains.run(book, routed.wallet, () =>
        this.decideOnBook(book, routed),
      ),
    );
    const completion = Promise.allSettled(tasks).then((results) =>
      this.finishSignal(routed, books, results),
    );
    this.completions.add(completion);
    void completion.finally(() => this.completions.delete(completion));
  }

  private async rebuildSignal(
    signal: Signal,
    fillIds: bigint[],
  ): Promise<Signal | null> {
    const fills = await this.prisma.leaderFill.findMany({
      where: { id: { in: fillIds } },
      select: STORED_FILL_SELECT,
    });
    if (fills.length === 0) {
      return null;
    }
    return buildCoinSignal(
      signal.wallet,
      signal.coin,
      orderByIds(fills, fillIds).map(toSignalFill),
      signal.source,
    );
  }

  private async readTargetBooks(signal: Signal): Promise<BookName[]> {
    const [wallet, copies] = await Promise.all([
      this.prisma.wallet.findUnique({
        where: { address: signal.wallet },
        select: { status: true },
      }),
      this.prisma.copyPosition.findMany({
        where: {
          walletAddress: signal.wallet,
          coin: signal.coin,
          isOpen: true,
        },
        select: { book: true },
        distinct: ['book'],
      }),
    ]);
    const books = new Set<BookName>();
    if (wallet?.status === 'LIVE') {
      books.add('MAIN');
    }
    if (wallet?.status === 'SHADOW') {
      books.add('SHADOW');
    }
    for (const copy of copies) {
      books.add(copy.book);
    }
    const pending = this.inFlightBooks.get(`${signal.wallet}:${signal.coin}`);
    for (const [book, count] of pending ?? []) {
      if (count > 0) {
        books.add(book);
      }
    }
    return [...books];
  }

  private countInFlight(signal: Signal, books: BookName[], step: number): void {
    const key = `${signal.wallet}:${signal.coin}`;
    const counts = this.inFlightBooks.get(key) ?? new Map<BookName, number>();
    for (const book of books) {
      counts.set(book, (counts.get(book) ?? 0) + step);
      if ((counts.get(book) ?? 0) <= 0) {
        counts.delete(book);
      }
    }
    if (counts.size === 0) {
      this.inFlightBooks.delete(key);
    } else {
      this.inFlightBooks.set(key, counts);
    }
  }

  private async finishSignal(
    signal: Signal,
    books: BookName[],
    results: PromiseSettledResult<void>[],
  ): Promise<void> {
    this.countInFlight(signal, books, -1);
    let hasFailed = false;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        hasFailed = true;
        this.logger.error(
          `Signal ${signal.key} failed on the ${books[index]} book, its fills stay unsignalled for the next catch-up`,
          result.reason instanceof Error
            ? result.reason.stack
            : String(result.reason),
        );
      }
    });
    try {
      if (!hasFailed) {
        await this.prisma.leaderFill.updateMany({
          where: { id: { in: signal.fillIds }, signalledAt: null },
          data: { signalledAt: new Date() },
        });
      }
    } catch (error) {
      this.logger.error(
        `Failed to mark the fills of signal ${signal.key} as signalled`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      for (const id of signal.fillIds) {
        this.inFlightFills.delete(id);
      }
    }
  }

  private async decideOnBook(book: BookName, signal: Signal): Promise<void> {
    const pending = await this.resolveDecidedFills(book, signal);
    if (pending === null) {
      return;
    }
    const latestLeaderTime = await this.readLatestLeaderTime(book, pending);
    if (latestLeaderTime !== null) {
      if (pending.lastFillTime < latestLeaderTime) {
        await this.recordOutOfOrder(book, pending);
        return;
      }
      const split = await this.splitAtLeaderTime(pending, latestLeaderTime);
      if (split !== null) {
        this.logger.log(
          `Signal ${pending.key} on the ${book} book holds fills older than the last decided fill at ${latestLeaderTime.toISOString()}, deciding its later fills as ${split.later.key}`,
        );
        await this.recordOutOfOrder(book, split.older);
        await this.decideOnBook(book, split.later);
        return;
      }
    }
    let view = await this.bookState.readBookView(book, pending.wallet);
    if (book === 'MAIN') {
      view = await this.killSwitch.enforceDailyLossLimit(view);
      this.metrics.bookEquityUsd.set({ book }, view.equityUsd.toNumber());
    }
    const decision = decide(pending, {
      book: view,
      market: this.bookState.readMarketView(pending.coin),
      leader: await this.readLeaderView(pending.wallet),
      settings: this.settings,
      now: new Date(),
    });
    if (decision === null) {
      return;
    }
    const stored = await this.storeDecision(decision);
    if (stored === null) {
      return;
    }
    this.recordDecision(stored.row, pending);
    await this.applyDecision(decision, stored);
  }

  private async resolveDecidedFills(
    book: BookName,
    signal: Signal,
  ): Promise<Signal | null> {
    const existing = await this.prisma.copyDecision.findUnique({
      where: { book_signalKey: { book, signalKey: signal.key } },
      select: { id: true, positionAfter: true, leaderTime: true },
    });
    if (existing === null) {
      return signal;
    }
    const isSameSignal =
      signal.positionAfter.equals(existing.positionAfter.toString()) &&
      signal.lastFillTime.getTime() === existing.leaderTime.getTime();
    if (isSameSignal) {
      this.logger.log(
        `Signal ${signal.key} was already decided on the ${book} book as decision ${existing.id}`,
      );
      return null;
    }
    const laterFills = await this.prisma.leaderFill.findMany({
      where: { id: { in: signal.fillIds }, time: { gt: existing.leaderTime } },
      select: STORED_FILL_SELECT,
    });
    if (laterFills.length === 0) {
      return null;
    }
    const rest = buildCoinSignal(
      signal.wallet,
      signal.coin,
      orderByIds(laterFills, signal.fillIds).map(toSignalFill),
      signal.source,
    );
    this.logger.log(
      `Signal ${signal.key} on the ${book} book was decided up to ${existing.leaderTime.toISOString()} by decision ${existing.id}, deciding ${laterFills.length} later fills as ${rest.key}`,
    );
    return this.resolveDecidedFills(book, rest);
  }

  private async readLatestLeaderTime(
    book: BookName,
    signal: Signal,
  ): Promise<Date | null> {
    const latest = await this.prisma.copyDecision.findFirst({
      where: { book, walletAddress: signal.wallet, coin: signal.coin },
      orderBy: { leaderTime: 'desc' },
      select: { leaderTime: true },
    });
    return latest?.leaderTime ?? null;
  }

  private async splitAtLeaderTime(
    signal: Signal,
    leaderTime: Date,
  ): Promise<{ older: Signal; later: Signal } | null> {
    const olderCount = await this.prisma.leaderFill.count({
      where: { id: { in: signal.fillIds }, time: { lt: leaderTime } },
    });
    if (olderCount === 0) {
      return null;
    }
    const fills = orderByIds(
      await this.prisma.leaderFill.findMany({
        where: { id: { in: signal.fillIds } },
        select: STORED_FILL_SELECT,
      }),
      signal.fillIds,
    ).map(toSignalFill);
    const build = (part: SignalFill[]) =>
      buildCoinSignal(signal.wallet, signal.coin, part, signal.source);
    return {
      older: build(fills.filter((fill) => fill.time < leaderTime)),
      later: build(fills.filter((fill) => fill.time >= leaderTime)),
    };
  }

  private async recordOutOfOrder(
    book: BookName,
    signal: Signal,
  ): Promise<void> {
    const action = classifyLeaderMove(signal);
    if (action === null) {
      return;
    }
    const decidedAt = new Date();
    try {
      const row = await this.prisma.copyDecision.create({
        data: {
          book,
          walletAddress: signal.wallet,
          coin: signal.coin,
          signalKey: signal.key,
          signalSource: signal.source,
          action,
          positionBefore: signal.positionBefore.toFixed(),
          positionAfter: signal.positionAfter.toFixed(),
          leaderVwap: signal.vwap.toFixed(),
          leaderTime: signal.lastFillTime,
          receivedAt: signal.receivedAt,
          decidedAt,
          verdict: 'SKIP',
          reason: OUT_OF_ORDER,
          trace: buildOutOfOrderTrace(
            `last fill at ${signal.lastFillTime.toISOString()} is older than the last fill already decided for ${signal.coin} on the ${book} book`,
          ),
        },
      });
      this.recordDecision(row, signal);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
  }

  private async readLeaderView(wallet: string): Promise<LeaderView> {
    const leader = await this.prisma.wallet.findUnique({
      where: { address: wallet },
      include: { state: true },
    });
    const equity = leader?.state?.equityUsd ?? null;
    return {
      wallet,
      status: leader?.status ?? 'CANDIDATE',
      isPaused: leader?.isPaused ?? false,
      equityUsd: equity === null ? null : new Decimal(equity.toString()),
      equityAt: leader?.state?.equityAt ?? null,
    };
  }

  private async storeDecision(
    decision: Decision,
  ): Promise<StoredDecision | null> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const row = await transaction.copyDecision.create({
          data: {
            book: decision.book,
            walletAddress: decision.wallet,
            coin: decision.coin,
            signalKey: decision.signalKey,
            signalSource: decision.signalSource,
            action: decision.action,
            positionBefore: decision.positionBefore.toFixed(),
            positionAfter: decision.positionAfter.toFixed(),
            leaderVwap: decision.leaderVwap.toFixed(),
            leaderTime: decision.leaderTime,
            receivedAt: decision.receivedAt,
            decidedAt: decision.decidedAt,
            verdict: decision.verdict,
            reason: decision.reason,
            trace: decision.trace,
            targetSize: decision.targetSize?.toFixed() ?? null,
            orderSize: decision.orderSize?.toFixed() ?? null,
          },
        });
        const deferredCopy =
          decision.opensCopy !== null && !decision.opensCopy.waitsForFill
            ? await this.positions.createCopy(
                decision.opensCopy,
                decision.decidedAt,
                transaction,
              )
            : null;
        const sync = decision.leaderSizeSync;
        if (sync !== null && !sync.waitsForFill) {
          await transaction.copyPosition.update({
            where: { id: sync.copyId },
            data: { leaderSizeAtSync: sync.leaderSizeAtSync.toFixed() },
          });
        }
        return { row, deferredCopy };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.log(
          `Signal ${decision.signalKey} was decided on the ${decision.book} book meanwhile`,
        );
        return null;
      }
      throw error;
    }
  }

  private recordDecision(row: CopyDecision, signal: Signal): void {
    this.metrics.decisionsTotal.inc({
      book: row.book,
      verdict: row.verdict,
      reason: row.reason,
    });
    if (row.signalSource === 'stream') {
      this.metrics.decisionLatencyMs.observe(
        row.decidedAt.getTime() - row.leaderTime.getTime(),
      );
    }
    this.events.publish({
      type: 'decision',
      book: row.book,
      decisionId: row.id,
      wallet: row.walletAddress,
      coin: row.coin,
      action: row.action,
      verdict: row.verdict,
      reason: row.reason,
      decidedAt: row.decidedAt,
    });
    this.logger.log(
      `Decision ${row.id} on the ${row.book} book for ${row.walletAddress} ${row.coin} tid ${signal.firstTid}: ${row.action} ${row.verdict} ${row.reason}, ${signal.source} signal, leader ${signal.positionBefore.toFixed()} to ${signal.positionAfter.toFixed()}`,
    );
  }

  private async applyDecision(
    decision: Decision,
    stored: StoredDecision,
  ): Promise<void> {
    const decisionId = stored.row.id;
    if (stored.deferredCopy !== null) {
      this.positions.announceChange(stored.deferredCopy, 'opened');
    }
    const closeReason = closeReasonFor('EXIT', decision.action);
    const exit = decision.intents.find((intent) => intent.reduceOnly);
    const entry = decision.intents.find((intent) => !intent.reduceOnly);
    if (decision.closesCopyId !== null && exit === undefined) {
      await this.execution.closeWithoutOrder(
        decision.closesCopyId,
        closeReason,
      );
    }
    let isExitComplete = true;
    if (exit !== undefined) {
      const closesCopy = exit.copyId === decision.closesCopyId;
      const isFlat = await this.execution.executeExit({
        intent: exit,
        decisionId,
        closeReason: closesCopy ? closeReason : null,
        leaderSizeSync:
          decision.leaderSizeSync?.copyId === exit.copyId
            ? decision.leaderSizeSync
            : null,
      });
      isExitComplete = !closesCopy || isFlat;
    }
    if (entry === undefined) {
      return;
    }
    if (!isExitComplete) {
      this.logger.warn(
        `Entry of decision ${decisionId} on ${decision.coin} is skipped, because the close before it is still open`,
      );
      return;
    }
    await this.execution.executeEntry({
      intent: entry,
      decisionId,
      opensCopy: decision.opensCopy,
      leaderSizeSync:
        entry.copyId !== null &&
        decision.leaderSizeSync?.copyId === entry.copyId
          ? decision.leaderSizeSync
          : null,
      decidedAt: decision.decidedAt,
    });
  }
}
