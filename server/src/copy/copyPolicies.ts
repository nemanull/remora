import { Decimal } from 'decimal.js';
import {
  type EntryCap,
  type EntrySizing,
  type ExitSizing,
  limitPrice,
  MIN_ORDER_NOTIONAL_USD,
  sizeEntry,
  sizeExit,
} from './copySizing';
import type {
  BookName,
  BookView,
  CopyAction,
  CopySettings,
  CopyView,
  DecisionReason,
  LeaderView,
  MarketView,
  PolicyName,
  PolicyOutcome,
  Signal,
} from './types';

export const POLICY_ORDER: readonly PolicyName[] = [
  'instrument',
  'leader_mode',
  'episode',
  'exit_path',
  'kill_switch',
  'signal_age',
  'price_drift',
  'coin_lock',
  'leader_equity',
  'sizing',
  'margin',
];

export const MAIN_BOOK_POLICIES: readonly PolicyName[] = POLICY_ORDER;

export const SHADOW_BOOK_POLICIES: readonly PolicyName[] = [
  'instrument',
  'leader_mode',
  'episode',
  'exit_path',
  'signal_age',
  'price_drift',
  'leader_equity',
  'sizing',
];

export const MID_MAX_AGE_MS = 10_000;
const MAJOR_COINS = new Set(['BTC', 'ETH']);
const BASIS_POINTS = 10_000;

export type ExitLeg = {
  kind: 'close' | 'reduce';
  copy: CopyView;
};

export type EntryLeg =
  | { kind: 'open'; leaderOpenTid: bigint }
  | { kind: 'increase'; copy: CopyView };

export type EpisodePlan = {
  action: CopyAction;
  outcome: PolicyOutcome;
  exit: ExitLeg | null;
  entry: EntryLeg | null;
};

export type ExitOrder = {
  isBuy: boolean;
  size: Decimal;
  limitPx: Decimal;
  isExactClose: boolean;
};

export type ExitPathCheck = {
  outcome: PolicyOutcome;
  sizing: ExitSizing;
  order: ExitOrder | null;
};

export type SizingCheck = {
  outcome: PolicyOutcome;
  sizing: EntrySizing;
};

export function allow(detail: string): PolicyOutcome {
  return { outcome: 'allow', reason: null, detail };
}

export function clip(reason: DecisionReason, detail: string): PolicyOutcome {
  return { outcome: 'clip', reason, detail };
}

export function reject(reason: DecisionReason, detail: string): PolicyOutcome {
  return { outcome: 'reject', reason, detail };
}

export function skip(detail: string): PolicyOutcome {
  return { outcome: 'skip', reason: null, detail };
}

export function policiesForBook(book: BookName): readonly PolicyName[] {
  return book === 'MAIN' ? MAIN_BOOK_POLICIES : SHADOW_BOOK_POLICIES;
}

export function driftLimitBps(coin: string, settings: CopySettings): number {
  return MAJOR_COINS.has(coin)
    ? settings.driftLimitMajorBps
    : settings.driftLimitOtherBps;
}

function isMainDexCoin(coin: string): boolean {
  return !coin.includes(':') && !coin.startsWith('@') && !coin.startsWith('#');
}

function signOf(value: Decimal): number {
  if (value.isZero()) {
    return 0;
  }
  return value.isNegative() ? -1 : 1;
}

function text(value: Decimal): string {
  return value.toFixed();
}

function usd(value: Decimal): string {
  return value.toFixed(2);
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(1);
}

function leaderAction(signal: Signal): CopyAction {
  const before = signal.positionBefore;
  const after = signal.positionAfter;
  if (after.isZero()) {
    return 'CLOSE';
  }
  if (before.isZero()) {
    return 'OPEN';
  }
  if (signal.touchedZero || signOf(before) !== signOf(after)) {
    return 'FLIP';
  }
  return after.abs().gt(before.abs()) ? 'INCREASE' : 'REDUCE';
}

export function checkInstrument(input: {
  coin: string;
  market: MarketView | null;
  isEntry: boolean;
}): PolicyOutcome {
  const { coin, market } = input;
  if (market === null || market.isDelisted || !isMainDexCoin(coin)) {
    return reject(
      'unsupported_instrument',
      `${coin} is not a listed main-dex perp`,
    );
  }
  const isIsolated =
    market.onlyIsolated ||
    market.marginMode === 'strictIsolated' ||
    market.marginMode === 'noCross';
  if (input.isEntry && isIsolated) {
    const mode = market.onlyIsolated
      ? 'only trades isolated'
      : `has margin mode ${market.marginMode}`;
    return reject(
      'isolated_only_market',
      `${coin} ${mode}, so entries are refused and exits still run`,
    );
  }
  return allow(
    isIsolated
      ? `${coin} is a main-dex perp, and exits run on isolated markets`
      : `${coin} is a main-dex perp with cross margin`,
  );
}

export function checkLeaderMode(
  book: BookName,
  leader: LeaderView,
): PolicyOutcome {
  const copiedStatus = book === 'MAIN' ? 'LIVE' : 'SHADOW';
  if (leader.status !== copiedStatus) {
    return reject(
      'leader_not_copied',
      `leader is ${leader.status} and the ${book} book copies ${copiedStatus} leaders`,
    );
  }
  if (leader.isPaused) {
    return reject('leader_paused', `leader is ${leader.status} but paused`);
  }
  return allow(`leader is ${leader.status} and not paused`);
}

export function checkEpisode(
  signal: Signal,
  copy: CopyView | null,
): EpisodePlan | null {
  const before = signal.positionBefore;
  const after = signal.positionAfter;
  if (before.equals(after) && !signal.touchedZero) {
    return null;
  }
  const move = `leader went from ${text(before)} to ${text(after)}`;
  const openTid = signal.episodeOpenTid;
  if (copy === null) {
    if (!after.isZero() && openTid !== null) {
      return {
        action: 'OPEN',
        outcome: allow(`${move}, an episode opened at tid ${openTid}`),
        exit: null,
        entry: { kind: 'open', leaderOpenTid: openTid },
      };
    }
    if (before.isZero() && after.isZero()) {
      return null;
    }
    return {
      action: leaderAction(signal),
      outcome: reject(
        'position_not_copied',
        `${move} on an episode that began before the signal and has no copy`,
      ),
      exit: null,
      entry: null,
    };
  }
  const synced = copy.leaderSizeAtSync;
  const endsEpisode =
    signal.touchedZero ||
    before.isZero() ||
    after.isZero() ||
    signOf(after) !== signOf(synced);
  if (endsEpisode) {
    const exit: ExitLeg = { kind: 'close', copy };
    if (!after.isZero() && openTid !== null) {
      return {
        action: 'FLIP',
        outcome: allow(
          `${move}, so the copied episode ended and ${text(after)} opens a new one at tid ${openTid}`,
        ),
        exit,
        entry: { kind: 'open', leaderOpenTid: openTid },
      };
    }
    return {
      action: 'CLOSE',
      outcome: allow(
        after.isZero()
          ? `${move}, so the copied episode ended`
          : `${move}, so the copied episode ended and the rest is not copied`,
      ),
      exit,
      entry: null,
    };
  }
  const leaderGrew = after.abs().gt(before.abs());
  const syncedText = `the synced ${text(synced)}`;
  if (after.abs().gt(synced.abs())) {
    if (leaderGrew) {
      return {
        action: 'INCREASE',
        outcome: allow(`${move}, past ${syncedText}`),
        exit: null,
        entry: { kind: 'increase', copy },
      };
    }
    return {
      action: 'REDUCE',
      outcome: reject(
        'already_at_target',
        `${move}, still above ${syncedText}, and a leader reduce never grows the copy`,
      ),
      exit: null,
      entry: null,
    };
  }
  if (after.abs().lt(synced.abs())) {
    return {
      action: 'REDUCE',
      outcome: allow(`${move}, below ${syncedText}`),
      exit: { kind: 'reduce', copy },
      entry: null,
    };
  }
  return {
    action: leaderGrew ? 'INCREASE' : 'REDUCE',
    outcome: reject('already_at_target', `${move}, back at ${syncedText}`),
    exit: null,
    entry: null,
  };
}

export function checkExitPath(input: {
  exit: ExitLeg;
  leaderSize: Decimal;
  market: MarketView;
  leaderVwap: Decimal;
  exitSlippageBps: number;
}): ExitPathCheck {
  const { exit, market } = input;
  const copySize = exit.copy.size;
  const mid = market.mid ?? input.leaderVwap;
  const priceSource =
    market.mid === null
      ? `the leader's VWAP ${text(mid)} as no mid is known`
      : `the mid ${text(mid)}`;
  const sizing = sizeExit({
    kind: exit.kind,
    copySize,
    leaderSize: input.leaderSize,
    leaderSizeAtSync: exit.copy.leaderSizeAtSync,
    mid,
    szDecimals: market.szDecimals,
  });
  if (sizing.result === 'no_size') {
    return {
      outcome:
        exit.kind === 'close'
          ? allow('the copy holds no size and closes without an order')
          : reject(
              'already_at_target',
              'the copy holds no size, so the reduce needs no order',
            ),
      sizing,
      order: null,
    };
  }
  if (sizing.result === 'below_min_notional') {
    return {
      outcome: reject(
        'below_min_notional',
        `reduce of ${text(sizing.orderSize)} worth ${usd(sizing.orderNotionalUsd)} USD waits under the ${usd(MIN_ORDER_NOTIONAL_USD)} USD minimum, and the synced ${text(exit.copy.leaderSizeAtSync)} stays`,
      ),
      sizing,
      order: null,
    };
  }
  const isBuy = copySize.isNegative();
  const limitPx = limitPrice(
    mid,
    isBuy,
    input.exitSlippageBps,
    market.szDecimals,
  );
  const order = `${isBuy ? 'buy' : 'sell'} ${text(sizing.orderSize)} reduce-only at ${text(limitPx)}, ${input.exitSlippageBps} bps through ${priceSource}`;
  const remaining = isBuy
    ? copySize.plus(sizing.orderSize)
    : copySize.minus(sizing.orderSize);
  return {
    outcome: allow(
      exit.kind === 'close'
        ? `close the whole copy, ${order}`
        : `reduce the copy from ${text(copySize)} to ${text(remaining)}, ${order}`,
    ),
    sizing,
    order: {
      isBuy,
      size: sizing.orderSize,
      limitPx,
      isExactClose: sizing.isExactClose,
    },
  };
}

export function checkKillSwitch(
  book: BookView,
  dailyLossLimit: number,
): PolicyOutcome {
  if (book.killSwitchActive) {
    return reject(
      'kill_switch_active',
      book.killSwitchReason === null
        ? 'kill switch is on'
        : `kill switch is on: ${book.killSwitchReason}`,
    );
  }
  const dayStart = book.dayStartEquity;
  if (dayStart === null || dayStart.lte(0)) {
    return allow('kill switch is off and the day has no starting equity');
  }
  const change = book.equityUsd.div(dayStart).minus(1).mul(100);
  const comparison = `equity ${usd(book.equityUsd)} USD is ${change.abs().toFixed(2)}% ${change.isNegative() ? 'below' : 'above'} the day's start ${usd(dayStart)} USD, limit ${(dailyLossLimit * 100).toFixed(2)}% below`;
  const floor = dayStart.mul(new Decimal(1).minus(dailyLossLimit));
  return book.equityUsd.lte(floor)
    ? reject('kill_switch_active', comparison)
    : allow(`kill switch is off and ${comparison}`);
}

export function checkSignalAge(
  lastFillTime: Date,
  now: Date,
  maxAgeMs: number,
): PolicyOutcome {
  const ageMs = now.getTime() - lastFillTime.getTime();
  const detail = `last fill ${ageMs} ms before the decision, limit ${maxAgeMs} ms`;
  return ageMs > maxAgeMs ? reject('stale_signal', detail) : allow(detail);
}

export function checkPriceDrift(input: {
  coin: string;
  isBuy: boolean;
  leaderVwap: Decimal;
  mid: Decimal | null;
  midAt: Date | null;
  now: Date;
  limitBps: number;
}): PolicyOutcome {
  if (input.mid === null) {
    return reject('mid_unavailable', `no mid is known for ${input.coin}`);
  }
  if (input.midAt === null) {
    return reject(
      'mid_unavailable',
      `the mid of ${input.coin} has no known time`,
    );
  }
  const midAgeMs = input.now.getTime() - input.midAt.getTime();
  if (midAgeMs > MID_MAX_AGE_MS) {
    return reject(
      'mid_unavailable',
      `the mid of ${input.coin} is ${midAgeMs} ms old, limit ${MID_MAX_AGE_MS} ms`,
    );
  }
  const worseBy = input.isBuy
    ? input.mid.minus(input.leaderVwap)
    : input.leaderVwap.minus(input.mid);
  const driftBps = worseBy.div(input.leaderVwap).mul(BASIS_POINTS);
  const detail = `mid ${text(input.mid)} is ${driftBps.abs().toFixed(1)} bps ${driftBps.isNegative() ? 'better' : 'worse'} than the leader's VWAP ${text(input.leaderVwap)} for a ${input.isBuy ? 'buy' : 'sell'}, limit ${input.limitBps} bps`;
  return driftBps.gt(input.limitBps)
    ? reject('price_drift', detail)
    : allow(detail);
}

export function checkCoinLock(
  book: BookView,
  wallet: string,
  coin: string,
): PolicyOutcome {
  const owner = book.openCopies.find(
    (copy) => copy.coin === coin && copy.wallet !== wallet,
  );
  if (owner !== undefined) {
    return reject(
      'coin_owned_by_other_leader',
      `${coin} is held by a copy of ${owner.wallet}`,
    );
  }
  return allow(`no other leader holds ${coin} in the book`);
}

export function checkLeaderEquity(
  leader: LeaderView,
  now: Date,
  maxAgeMs: number,
): PolicyOutcome {
  if (leader.equityUsd === null || leader.equityAt === null) {
    return reject('leader_equity_stale', 'leader equity is unknown');
  }
  if (leader.equityUsd.lte(0)) {
    return reject(
      'leader_equity_stale',
      `leader equity ${usd(leader.equityUsd)} USD is not positive`,
    );
  }
  const ageMs = now.getTime() - leader.equityAt.getTime();
  const detail = `leader equity ${usd(leader.equityUsd)} USD is ${seconds(ageMs)} s old, limit ${seconds(maxAgeMs)} s`;
  return ageMs > maxAgeMs
    ? reject('leader_equity_stale', detail)
    : allow(detail);
}

function describeCap(cap: EntryCap, maxOpenCopies: number): string {
  switch (cap.name) {
    case 'position':
      return `per-position cap of ${usd(cap.remainingUsd)} USD`;
    case 'leader':
      return `per-leader cap with ${usd(Decimal.max(cap.remainingUsd, 0))} USD left`;
    case 'gross':
      return `gross exposure cap with ${usd(Decimal.max(cap.remainingUsd, 0))} USD left`;
    case 'open_copies':
      return `limit of ${maxOpenCopies} open copies`;
  }
}

export function checkSizing(input: {
  isOpen: boolean;
  ratio: Decimal;
  leaderSize: Decimal;
  copySize: Decimal;
  mid: Decimal;
  szDecimals: number;
  caps: EntryCap[];
  maxOpenCopies: number;
}): SizingCheck {
  const sizing = sizeEntry(input);
  const target = `target ${text(sizing.target)} at ratio ${text(input.ratio)}`;
  const cap =
    sizing.bindingCap === null
      ? null
      : describeCap(sizing.bindingCap, input.maxOpenCopies);
  if (sizing.result === 'at_target') {
    return {
      outcome:
        cap === null
          ? reject(
              'already_at_target',
              `${target} does not exceed the copy's ${text(input.copySize)}`,
            )
          : reject(
              'cap_reached',
              `the ${cap} leaves no room above the copy's ${text(input.copySize)}`,
            ),
      sizing,
    };
  }
  const order = `order ${text(sizing.orderSize)} worth ${usd(sizing.orderNotionalUsd)} USD`;
  if (sizing.result === 'below_min_notional') {
    const consequence = input.isOpen
      ? 'the copy opens at size 0 with its ratio frozen'
      : cap === null
        ? 'the synced leader size stays'
        : `the ${cap} binds, so the synced leader size moves`;
    return {
      outcome: reject(
        'below_min_notional',
        `${target}, ${order} is under the ${usd(MIN_ORDER_NOTIONAL_USD)} USD minimum, ${consequence}`,
      ),
      sizing,
    };
  }
  if (cap !== null) {
    return {
      outcome: clip(
        'cap_reached',
        `target clipped from ${text(sizing.rawTarget)} to ${text(sizing.target)} by the ${cap}, ${order}`,
      ),
      sizing,
    };
  }
  return { outcome: allow(`${target}, ${order}`), sizing };
}

export function checkMargin(input: {
  freeMarginUsd: Decimal;
  orderNotionalUsd: Decimal;
  leverage: number;
  marginBuffer: number;
}): PolicyOutcome {
  const initialMargin = input.orderNotionalUsd.div(input.leverage);
  const required = initialMargin.mul(input.marginBuffer);
  const detail = `free margin ${usd(input.freeMarginUsd)} USD against ${input.marginBuffer} times the initial margin ${usd(initialMargin)} USD at ${input.leverage}x`;
  return input.freeMarginUsd.lt(required)
    ? reject('insufficient_margin', detail)
    : allow(detail);
}
