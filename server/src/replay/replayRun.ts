import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type Candle,
  type FundingHistoryItem,
  type HyperliquidFill,
  HyperliquidInfoClient,
  type PortfolioResponse,
} from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { markBook, measureNetPnl } from '../books/bookEquity';
import type { GapOrder } from '../books/copyGap';
import { fundingPayment } from '../books/paperFunding';
import { applyFill } from '../books/positionFills';
import type { ServerConfig } from '../config';
import { readCopySettingsFromConfig } from '../copy/copyDecision.service';
import { buildCloseIntent, decide } from '../copy/copyEngine';
import { stopPrice } from '../copy/copySizing';
import { buildCoinSignal, type SignalFill } from '../copy/signalBuilder';
import type {
  BookView,
  CopySettings,
  CopyView,
  Decision,
  LeaderView,
  MarketView,
  NewCopy,
  OrderIntent,
  Signal,
} from '../copy/types';
import { isMainDexPerp } from '../ingestion/fillClassification';
import { type Market, readMarkets } from '../market/marketData.service';
import { measureDriftedMid, ReplayExecutor } from './replayExecutor';

const DAY_MS = 86_400_000;
const FILLS_PAGE_SIZE = 2_000;
const FILL_HORIZON = 10_000;
const FUNDING_PAGE_SIZE = 500;
const CANDLE_INTERVAL = '15m';
const COMBINED_WINDOWS = new Set(['day', 'week', 'month', 'allTime']);

export type ReplayOptions = {
  wallet: string;
  days: number;
  allocationUsd: number;
  latencyMs: number;
  driftBps: number;
  end?: Date;
};

export type EquityPoint = {
  time: number;
  value: Decimal;
};

export type ReplayInput = {
  wallet: string;
  source: string;
  start: Date;
  end: Date;
  fills: HyperliquidFill[];
  candles: ReadonlyMap<string, Candle[]>;
  funding: ReadonlyMap<string, FundingHistoryItem[]>;
  equity: EquityPoint[];
  markets: ReadonlyMap<string, Market>;
  settings: CopySettings;
  latencyMs: number;
  driftBps: number;
  takerFeeBps: number;
  stopLossShare: number;
  stopMaxDistance: number;
};

export type ReplayCopy = {
  id: bigint;
  coin: string;
  size: Decimal;
  entryPx: Decimal | null;
  ratio: Decimal;
  leaderSizeAtSync: Decimal;
  allocationUsd: Decimal;
  leaderOpenTid: bigint;
  openedAt: Date;
  lastOrderAt: Date | null;
  stopPx: Decimal | null;
  realizedPnl: Decimal;
  feesUsd: Decimal;
  fundingUsd: Decimal;
  isOpen: boolean;
  closedAt: Date | null;
  closeReason: string | null;
  orders: GapOrder[];
};

export type ReplayOutcome = {
  signals: number;
  decisions: Decision[];
  copies: ReplayCopy[];
  marks: ReadonlyMap<string, Decimal>;
};

type ReplayEvent =
  | { time: number; order: number; kind: 'funding'; item: FundingHistoryItem }
  | {
      time: number;
      order: number;
      kind: 'candle';
      coin: string;
      candle: Candle;
    }
  | { time: number; order: number; kind: 'signal'; signal: Signal };

export function groupReplaySignals(
  wallet: string,
  fills: HyperliquidFill[],
): Signal[] {
  const signals: Signal[] = [];
  const pending = new Map<string, SignalFill[]>();
  const flush = (coin: string): void => {
    const group = pending.get(coin);
    if (group !== undefined && group.length > 0) {
      signals.push(buildCoinSignal(wallet, coin, group, 'stream'));
    }
    pending.delete(coin);
  };
  fills.forEach((fill, index) => {
    const group = pending.get(fill.coin);
    if (group !== undefined && group[0].time.getTime() !== fill.time) {
      flush(fill.coin);
    }
    const time = new Date(fill.time);
    const signalFill: SignalFill = {
      id: BigInt(index + 1),
      coin: fill.coin,
      tid: BigInt(fill.tid),
      price: new Decimal(fill.px),
      size: new Decimal(fill.sz),
      isBuy: fill.side === 'B',
      startPosition: new Decimal(fill.startPosition),
      time,
      receivedAt: time,
    };
    pending.set(fill.coin, [...(pending.get(fill.coin) ?? []), signalFill]);
  });
  for (const coin of [...pending.keys()]) {
    flush(coin);
  }
  return signals.sort(
    (left, right) =>
      left.lastFillTime.getTime() - right.lastFillTime.getTime() ||
      (left.firstTid < right.firstTid ? -1 : 1),
  );
}

export function readEquityHistory(portfolio: PortfolioResponse): EquityPoint[] {
  const points = new Map<number, Decimal>();
  for (const [window, period] of portfolio) {
    if (!COMBINED_WINDOWS.has(window)) {
      continue;
    }
    for (const [time, value] of period.accountValueHistory) {
      points.set(time, new Decimal(value));
    }
  }
  return [...points]
    .map(([time, value]) => ({ time, value }))
    .sort((left, right) => left.time - right.time);
}

export function interpolateEquity(
  points: EquityPoint[],
  time: number,
): Decimal | null {
  if (points.length === 0 || time < points[0].time) {
    return null;
  }
  const afterIndex = points.findIndex((point) => point.time >= time);
  if (afterIndex === -1) {
    return points[points.length - 1].value;
  }
  const after = points[afterIndex];
  if (after.time === time) {
    return after.value;
  }
  const before = points[afterIndex - 1];
  const share = (time - before.time) / (after.time - before.time);
  return before.value.plus(after.value.minus(before.value).mul(share));
}

function exchangeLeverage(market: Market, settings: CopySettings): number {
  return Math.max(
    1,
    Math.min(market.maxLeverage, settings.maxExchangeLeverage),
  );
}

class ReplayBook {
  readonly copies: ReplayCopy[] = [];
  readonly marks = new Map<string, Decimal>();
  private nextId = 1n;

  constructor(
    private readonly input: ReplayInput,
    private readonly executor: ReplayExecutor,
  ) {}

  readOpen(): ReplayCopy[] {
    return this.copies.filter((copy) => copy.isOpen);
  }

  readView(): BookView {
    const open = this.readOpen();
    const marked = markBook(
      open.map((copy) => ({
        coin: copy.coin,
        size: copy.size,
        entryPx: copy.entryPx,
        mark: this.marks.get(copy.coin) ?? null,
        leverage: this.readLeverage(copy.coin),
      })),
    );
    const netPnl = this.copies.reduce(
      (total, copy) => total.plus(measureNetPnl(copy)),
      new Decimal(0),
    );
    const equityUsd = this.input.settings.shadowAllocationUsd
      .plus(netPnl)
      .plus(marked.unrealizedPnl);
    return {
      book: 'SHADOW',
      equityUsd,
      dayStartEquity: null,
      freeMarginUsd: equityUsd.minus(marked.initialMarginUsd),
      killSwitchActive: false,
      killSwitchReason: null,
      openCopies: open.map((copy) => this.toView(copy)),
    };
  }

  createCopy(newCopy: NewCopy, openedAt: Date): ReplayCopy {
    const copy: ReplayCopy = {
      id: this.nextId++,
      coin: newCopy.coin,
      size: new Decimal(0),
      entryPx: null,
      ratio: newCopy.ratio,
      leaderSizeAtSync: newCopy.leaderSizeAtSync,
      allocationUsd: newCopy.allocationUsd,
      leaderOpenTid: newCopy.leaderOpenTid,
      openedAt,
      lastOrderAt: null,
      stopPx: null,
      realizedPnl: new Decimal(0),
      feesUsd: new Decimal(0),
      fundingUsd: new Decimal(0),
      isOpen: true,
      closedAt: null,
      closeReason: null,
      orders: [],
    };
    this.copies.push(copy);
    return copy;
  }

  findCopy(id: bigint | null): ReplayCopy | null {
    return this.copies.find((copy) => copy.id === id && copy.isOpen) ?? null;
  }

  close(copy: ReplayCopy, reason: string, at: Date): void {
    copy.isOpen = false;
    copy.closedAt = at;
    copy.closeReason = reason;
    copy.stopPx = null;
  }

  async executeIntent(
    copy: ReplayCopy,
    intent: OrderIntent,
    at: Date,
  ): Promise<boolean> {
    const result = await this.executor.execute({
      cloid: `replay-${copy.id}-${copy.orders.length + 1}`,
      coin: intent.coin,
      isBuy: intent.isBuy,
      size: intent.size,
      limitPx: intent.limitPx,
      reduceOnly: intent.reduceOnly,
      heldSize: copy.size.abs(),
    });
    if (result.averagePrice === null || result.filledSize.isZero()) {
      return false;
    }
    const ledger = applyFill(copy, {
      isBuy: intent.isBuy,
      size: result.filledSize,
      price: result.averagePrice,
    });
    copy.size = ledger.size;
    copy.entryPx = ledger.entryPx;
    copy.realizedPnl = ledger.realizedPnl;
    copy.feesUsd = copy.feesUsd.plus(result.feeUsd);
    copy.lastOrderAt = at;
    copy.orders.push({
      purpose: intent.purpose,
      isBuy: intent.isBuy,
      filledSize: result.filledSize,
      averagePrice: result.averagePrice,
      referencePrice: intent.referencePx,
    });
    return true;
  }

  protect(copy: ReplayCopy): void {
    const market = this.input.markets.get(copy.coin);
    if (market === undefined || copy.entryPx === null) {
      return;
    }
    copy.stopPx = stopPrice({
      size: copy.size,
      entryPx: copy.entryPx,
      allocationUsd: copy.allocationUsd,
      lossShare: this.input.stopLossShare,
      maxDistance: this.input.stopMaxDistance,
      szDecimals: market.szDecimals,
    });
  }

  readExitSlippageBps(): number {
    return this.input.settings.exitSlippageBps;
  }

  readLeverage(coin: string): number {
    const market = this.input.markets.get(coin);
    return market === undefined
      ? 1
      : exchangeLeverage(market, this.input.settings);
  }

  toView(copy: ReplayCopy): CopyView {
    const mark = this.marks.get(copy.coin) ?? copy.entryPx ?? new Decimal(0);
    return {
      id: copy.id,
      wallet: this.input.wallet,
      coin: copy.coin,
      size: copy.size,
      ratio: copy.ratio,
      leaderSizeAtSync: copy.leaderSizeAtSync,
      allocationUsd: copy.allocationUsd,
      notionalUsd: copy.size.abs().mul(mark),
      openedAt: copy.openedAt,
      lastOrderAt: copy.lastOrderAt,
    };
  }
}

function buildEvents(input: ReplayInput, signals: Signal[]): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (const items of input.funding.values()) {
    for (const item of items) {
      events.push({ time: item.time, order: 0, kind: 'funding', item });
    }
  }
  for (const [coin, candles] of input.candles) {
    for (const candle of candles) {
      events.push({ time: candle.T, order: 1, kind: 'candle', coin, candle });
    }
  }
  for (const signal of signals) {
    events.push({
      time: signal.lastFillTime.getTime() + input.latencyMs,
      order: 2,
      kind: 'signal',
      signal,
    });
  }
  return events.sort(
    (left, right) => left.time - right.time || left.order - right.order,
  );
}

function readMarketView(market: Market, mid: Decimal, at: Date): MarketView {
  return {
    coin: market.coin,
    szDecimals: market.szDecimals,
    maxLeverage: market.maxLeverage,
    onlyIsolated: market.isOnlyIsolated,
    marginMode: market.marginMode,
    isDelisted: false,
    mid,
    midAt: at,
  };
}

async function applyReplayDecision(
  book: ReplayBook,
  decision: Decision,
  at: Date,
): Promise<void> {
  const closeReason =
    decision.action === 'FLIP' ? 'leader_flipped' : 'leader_closed';
  const exit = decision.intents.find((intent) => intent.reduceOnly);
  const entry = decision.intents.find((intent) => !intent.reduceOnly);
  if (decision.closesCopyId !== null && exit === undefined) {
    const closed = book.findCopy(decision.closesCopyId);
    if (closed !== null) {
      book.close(closed, closeReason, at);
    }
  }
  const sync = decision.leaderSizeSync;
  if (sync !== null && !sync.waitsForFill) {
    const synced = book.findCopy(sync.copyId);
    if (synced !== null) {
      synced.leaderSizeAtSync = sync.leaderSizeAtSync;
    }
  }
  if (decision.opensCopy !== null && !decision.opensCopy.waitsForFill) {
    book.createCopy(decision.opensCopy, at);
  }
  let isExitComplete = true;
  if (exit !== undefined) {
    const copy = book.findCopy(exit.copyId);
    if (copy !== null) {
      const isFilled = await book.executeIntent(copy, exit, at);
      if (isFilled && sync?.copyId === copy.id && sync.waitsForFill) {
        copy.leaderSizeAtSync = sync.leaderSizeAtSync;
      }
      const closesCopy = decision.closesCopyId === copy.id;
      if (closesCopy && copy.size.isZero()) {
        book.close(copy, closeReason, at);
      }
      isExitComplete = !closesCopy || !copy.isOpen;
    }
  }
  if (entry === undefined || !isExitComplete) {
    return;
  }
  const isNewCopy = entry.copyId === null;
  const copy =
    isNewCopy && decision.opensCopy !== null
      ? book.createCopy(decision.opensCopy, at)
      : book.findCopy(entry.copyId);
  if (copy === null) {
    return;
  }
  const isFilled = await book.executeIntent(copy, entry, at);
  if (!isFilled) {
    if (isNewCopy) {
      book.copies.splice(book.copies.indexOf(copy), 1);
    }
    return;
  }
  if (sync?.copyId === copy.id && sync.waitsForFill) {
    copy.leaderSizeAtSync = sync.leaderSizeAtSync;
  }
  book.protect(copy);
}

async function checkStop(
  book: ReplayBook,
  executor: ReplayExecutor,
  market: Market,
  candle: Candle,
): Promise<void> {
  const open = new Decimal(candle.o);
  const low = new Decimal(candle.l);
  const high = new Decimal(candle.h);
  const at = new Date(candle.T);
  for (const copy of book.readOpen()) {
    if (
      copy.coin !== market.coin ||
      copy.stopPx === null ||
      copy.openedAt.getTime() > candle.t
    ) {
      continue;
    }
    const isLong = copy.size.isPositive();
    const isCrossed = isLong ? low.lte(copy.stopPx) : high.gte(copy.stopPx);
    if (!isCrossed) {
      continue;
    }
    const stopPx = copy.stopPx;
    const triggerPx = isLong
      ? Decimal.min(stopPx, open)
      : Decimal.max(stopPx, open);
    executor.setMarket(market.coin, triggerPx, at);
    const intent = buildCloseIntent({
      book: 'SHADOW',
      copy: book.toView(copy),
      purpose: 'STOP',
      market: readMarketView(market, triggerPx, at),
      referencePx: stopPx,
      exitSlippageBps: book.readExitSlippageBps(),
    });
    if (intent !== null) {
      await book.executeIntent(copy, intent, at);
    }
    if (copy.size.isZero()) {
      book.close(copy, 'stop_loss', at);
    }
  }
}

export async function simulateReplay(
  input: ReplayInput,
): Promise<ReplayOutcome> {
  const executor = new ReplayExecutor(input.takerFeeBps);
  const book = new ReplayBook(input, executor);
  const signals = groupReplaySignals(input.wallet, input.fills);
  const decisions: Decision[] = [];
  for (const event of buildEvents(input, signals)) {
    if (event.kind === 'candle') {
      const market = input.markets.get(event.coin);
      if (market !== undefined) {
        await checkStop(book, executor, market, event.candle);
      }
      book.marks.set(event.coin, new Decimal(event.candle.c));
      continue;
    }
    if (event.kind === 'funding') {
      const mark = book.marks.get(event.item.coin);
      if (mark === undefined) {
        continue;
      }
      for (const copy of book.readOpen()) {
        if (
          copy.coin === event.item.coin &&
          copy.openedAt.getTime() <= event.item.time
        ) {
          copy.fundingUsd = copy.fundingUsd.plus(
            fundingPayment({
              size: copy.size,
              oraclePrice: mark,
              fundingRate: new Decimal(event.item.fundingRate),
            }),
          );
        }
      }
      continue;
    }
    const { signal } = event;
    const market = input.markets.get(signal.coin);
    const at = new Date(event.time);
    const isLeaderBuying = signal.positionAfter.gt(signal.positionBefore);
    const mid = measureDriftedMid(signal.vwap, isLeaderBuying, input.driftBps);
    if (market !== undefined) {
      executor.setMarket(signal.coin, mid, at);
      book.marks.set(signal.coin, mid);
    }
    const equity = interpolateEquity(input.equity, at.getTime());
    const leader: LeaderView = {
      wallet: input.wallet,
      status: 'SHADOW',
      isPaused: false,
      equityUsd: equity,
      equityAt: equity === null ? null : at,
    };
    const decision = decide(signal, {
      book: book.readView(),
      market: market === undefined ? null : readMarketView(market, mid, at),
      leader,
      settings: input.settings,
      now: at,
    });
    if (decision === null) {
      continue;
    }
    decisions.push(decision);
    await applyReplayDecision(book, decision, at);
  }
  return {
    signals: signals.length,
    decisions,
    copies: book.copies,
    marks: book.marks,
  };
}

@Injectable()
export class ReplayRun {
  private readonly takerFeeBps: number;
  private readonly stopLossShare: number;
  private readonly stopMaxDistance: number;
  private readonly settings: CopySettings;
  private readonly source: string;

  constructor(
    private readonly infoClient: HyperliquidInfoClient,
    config: ConfigService<ServerConfig, true>,
  ) {
    this.source = config.getOrThrow('HYPERLIQUID_API_URL', { infer: true });
    this.takerFeeBps = config.getOrThrow('TAKER_FEE_BPS', { infer: true });
    this.stopLossShare = config.getOrThrow('STOP_LOSS_ALLOCATION_SHARE', {
      infer: true,
    });
    this.stopMaxDistance = config.getOrThrow('STOP_MAX_DISTANCE', {
      infer: true,
    });
    this.settings = readCopySettingsFromConfig(config);
  }

  async run(options: ReplayOptions): Promise<{
    input: ReplayInput;
    outcome: ReplayOutcome;
    isTruncated: boolean;
  }> {
    const end = options.end ?? new Date();
    const start = new Date(end.getTime() - options.days * DAY_MS);
    const markets = readMarkets(await this.infoClient.metaAndAssetCtxs());
    const { fills, isTruncated } = await this.readFills(
      options.wallet,
      start,
      end,
    );
    const mainDexFills = fills.filter((fill) =>
      isMainDexPerp(fill.coin, markets),
    );
    const coins = [...new Set(mainDexFills.map((fill) => fill.coin))];
    const candles = new Map<string, Candle[]>();
    const funding = new Map<string, FundingHistoryItem[]>();
    for (const coin of coins) {
      candles.set(
        coin,
        await this.infoClient.candleSnapshot(
          coin,
          CANDLE_INTERVAL,
          start.getTime(),
          end.getTime(),
        ),
      );
      funding.set(coin, await this.readFunding(coin, start, end));
    }
    const allocationUsd = new Decimal(options.allocationUsd);
    const input: ReplayInput = {
      wallet: options.wallet,
      source: this.source,
      start,
      end,
      fills: mainDexFills,
      candles,
      funding,
      equity: readEquityHistory(
        await this.infoClient.portfolio(options.wallet),
      ),
      markets,
      settings: {
        ...this.settings,
        shadowAllocationUsd: allocationUsd,
        liveAllocationUsd: allocationUsd,
      },
      latencyMs: options.latencyMs,
      driftBps: options.driftBps,
      takerFeeBps: this.takerFeeBps,
      stopLossShare: this.stopLossShare,
      stopMaxDistance: this.stopMaxDistance,
    };
    return { input, outcome: await simulateReplay(input), isTruncated };
  }

  private async readFills(
    wallet: string,
    start: Date,
    end: Date,
  ): Promise<{ fills: HyperliquidFill[]; isTruncated: boolean }> {
    const byTid = new Map<number, HyperliquidFill>();
    let cursor = start.getTime();
    for (;;) {
      const page = await this.infoClient.userFillsByTime(
        wallet,
        cursor,
        end.getTime(),
      );
      const before = byTid.size;
      for (const fill of page) {
        byTid.set(fill.tid, fill);
      }
      const last = page.at(-1);
      if (
        page.length < FILLS_PAGE_SIZE ||
        last === undefined ||
        byTid.size === before ||
        byTid.size >= FILL_HORIZON
      ) {
        break;
      }
      cursor = last.time;
    }
    const fills = [...byTid.values()].sort(
      (left, right) => left.time - right.time,
    );
    return {
      fills: fills.slice(-FILL_HORIZON),
      isTruncated: fills.length >= FILL_HORIZON,
    };
  }

  private async readFunding(
    coin: string,
    start: Date,
    end: Date,
  ): Promise<FundingHistoryItem[]> {
    const items: FundingHistoryItem[] = [];
    let cursor = start.getTime();
    for (;;) {
      const page = await this.infoClient.fundingHistory(
        coin,
        cursor,
        end.getTime(),
      );
      items.push(...page);
      const last = page.at(-1);
      if (page.length < FUNDING_PAGE_SIZE || last === undefined) {
        return items;
      }
      cursor = last.time + 1;
    }
  }
}
