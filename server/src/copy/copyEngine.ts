import { Decimal } from 'decimal.js';
import type { ServerConfig } from '../config';
import {
  checkCoinLock,
  checkEpisode,
  checkExitPath,
  checkInstrument,
  checkKillSwitch,
  checkLeaderEquity,
  checkLeaderMode,
  checkMargin,
  checkPriceDrift,
  checkSignalAge,
  checkSizing,
  driftLimitBps,
  type EntryLeg,
  type EpisodePlan,
  type ExitOrder,
  type ExitPathCheck,
  POLICY_ORDER,
  policiesForBook,
  reject,
  skip,
  type SizingCheck,
} from './copyPolicies';
import { copyRatio, type EntryCap, limitPrice } from './copySizing';
import type {
  BookName,
  BookView,
  CopySettings,
  CopyView,
  Decision,
  DecisionContext,
  LeaderSizeSync,
  LeaderView,
  MarketView,
  NewCopy,
  OrderIntent,
  OrderPurpose,
  PolicyName,
  PolicyOutcome,
  Signal,
  TraceLine,
} from './types';

type Evaluation = {
  episode: EpisodePlan;
  policies: readonly PolicyName[];
  trace: TraceLine[];
  entryEndedBy: PolicyName | null;
  signalEndedBy: PolicyName | null;
};

type EntryOrder = {
  isBuy: boolean;
  size: Decimal;
  limitPx: Decimal;
};

type EntryResult = {
  leg: EntryLeg;
  ratio: Decimal;
  allocationUsd: Decimal;
  sizing: SizingCheck;
  order: EntryOrder | null;
};

export function readCopySettings(config: ServerConfig): CopySettings {
  return {
    liveAllocationUsd: new Decimal(config.LIVE_ALLOCATION_USD),
    shadowAllocationUsd: new Decimal(config.SHADOW_ALLOCATION_USD),
    signalMaxAgeMs: config.SIGNAL_MAX_AGE_MS,
    driftLimitMajorBps: config.DRIFT_LIMIT_MAJOR_BPS,
    driftLimitOtherBps: config.DRIFT_LIMIT_OTHER_BPS,
    exitSlippageBps: config.EXIT_SLIPPAGE_BPS,
    leaderEquityMaxAgeMs: config.LEADER_EQUITY_MAX_AGE_MS,
    positionCapMultiple: config.POSITION_CAP_MULTIPLE,
    grossExposureMultiple: config.GROSS_EXPOSURE_MULTIPLE,
    maxOpenCopies: config.MAX_OPEN_COPIES,
    marginBuffer: config.MARGIN_BUFFER,
    dailyLossLimit: config.DAILY_LOSS_LIMIT,
    maxExchangeLeverage: config.MAX_EXCHANGE_LEVERAGE,
  };
}

export function allocationForBook(
  book: BookName,
  settings: CopySettings,
): Decimal {
  return book === 'MAIN'
    ? settings.liveAllocationUsd
    : settings.shadowAllocationUsd;
}

export function exchangeLeverage(
  market: MarketView,
  settings: CopySettings,
): number {
  return Math.max(
    1,
    Math.min(market.maxLeverage, settings.maxExchangeLeverage),
  );
}

function findCopy(
  book: BookView,
  wallet: string,
  coin: string,
): CopyView | null {
  return (
    book.openCopies.find(
      (copy) => copy.wallet === wallet && copy.coin === coin,
    ) ?? null
  );
}

export function buildCloseIntent(input: {
  book: BookName;
  copy: CopyView;
  purpose: OrderPurpose;
  market: MarketView;
  referencePx: Decimal;
  exitSlippageBps: number;
}): OrderIntent | null {
  const check = checkExitPath({
    exit: { kind: 'close', copy: input.copy },
    leaderSize: new Decimal(0),
    market: input.market,
    leaderVwap: input.referencePx,
    exitSlippageBps: input.exitSlippageBps,
  });
  if (check.order === null) {
    return null;
  }
  return exitIntent(
    input.book,
    input.copy,
    input.purpose,
    check.order,
    input.referencePx,
  );
}

function exitIntent(
  book: BookName,
  copy: CopyView,
  purpose: OrderPurpose,
  order: ExitOrder,
  referencePx: Decimal,
): OrderIntent {
  return {
    book,
    wallet: copy.wallet,
    coin: copy.coin,
    copyId: copy.id,
    purpose,
    isBuy: order.isBuy,
    size: order.size,
    limitPx: order.limitPx,
    reduceOnly: true,
    isExactClose: order.isExactClose,
    referencePx,
  };
}

function record(
  evaluation: Evaluation,
  policy: PolicyName,
  outcome: PolicyOutcome,
): void {
  evaluation.trace.push({
    policy,
    outcome: outcome.outcome,
    reason: outcome.reason,
    detail: outcome.detail,
  });
}

function skipDetail(evaluation: Evaluation, policy: PolicyName): string {
  if (!evaluation.policies.includes(policy)) {
    return 'not applied in the shadow book';
  }
  if (evaluation.signalEndedBy !== null) {
    return `not evaluated after ${evaluation.signalEndedBy} rejected the signal`;
  }
  if (policy === 'exit_path') {
    return 'no exit in this signal';
  }
  if (evaluation.episode.entry === null) {
    return policy === 'leader_mode'
      ? 'applies to entries only'
      : 'skipped on the exit path';
  }
  return `not evaluated after ${evaluation.entryEndedBy} rejected the entry`;
}

function recordSkip(evaluation: Evaluation, policy: PolicyName): void {
  record(evaluation, policy, skip(skipDetail(evaluation, policy)));
}

function endEntry(evaluation: Evaluation, policy: PolicyName): void {
  evaluation.entryEndedBy = policy;
  if (evaluation.episode.exit === null) {
    evaluation.signalEndedBy = policy;
  }
}

function isEntryOpen(evaluation: Evaluation, policy: PolicyName): boolean {
  return (
    evaluation.policies.includes(policy) &&
    evaluation.signalEndedBy === null &&
    evaluation.episode.entry !== null &&
    evaluation.entryEndedBy === null
  );
}

function entryRatio(
  leg: EntryLeg,
  leader: LeaderView,
  allocationUsd: Decimal,
): Decimal | null {
  if (leg.kind === 'increase') {
    return leg.copy.ratio;
  }
  if (leader.equityUsd === null || leader.equityUsd.lte(0)) {
    return null;
  }
  return copyRatio(allocationUsd, leader.equityUsd);
}

function sumNotional(copies: CopyView[]): Decimal {
  return copies.reduce(
    (total, copy) => total.plus(copy.notionalUsd),
    new Decimal(0),
  );
}

function entryCaps(input: {
  book: BookView;
  settings: CopySettings;
  wallet: string;
  positionAllocationUsd: Decimal;
  replacedCopyId: bigint | null;
  isOpen: boolean;
}): EntryCap[] {
  const { book, settings } = input;
  const others = book.openCopies.filter(
    (copy) => copy.id !== input.replacedCopyId,
  );
  const leaderLimit = allocationForBook(book.book, settings).mul(
    settings.positionCapMultiple,
  );
  const caps: EntryCap[] = [
    {
      name: 'position',
      remainingUsd: input.positionAllocationUsd.mul(
        settings.positionCapMultiple,
      ),
    },
    {
      name: 'leader',
      remainingUsd: leaderLimit.minus(
        sumNotional(others.filter((copy) => copy.wallet === input.wallet)),
      ),
    },
  ];
  if (book.book === 'MAIN') {
    caps.push({
      name: 'gross',
      remainingUsd: book.equityUsd
        .mul(settings.grossExposureMultiple)
        .minus(sumNotional(others)),
    });
    if (input.isOpen && others.length >= settings.maxOpenCopies) {
      caps.push({ name: 'open_copies', remainingUsd: new Decimal(0) });
    }
  }
  return caps;
}

function evaluateEntryGates(
  evaluation: Evaluation,
  signal: Signal,
  context: DecisionContext,
  market: MarketView,
): void {
  const { book, leader, settings, now } = context;
  const leg = evaluation.episode.entry;
  const gates: [PolicyName, () => PolicyOutcome][] = [
    ['kill_switch', () => checkKillSwitch(book, settings.dailyLossLimit)],
    [
      'signal_age',
      () => checkSignalAge(signal.lastFillTime, now, settings.signalMaxAgeMs),
    ],
    [
      'price_drift',
      () =>
        checkPriceDrift({
          coin: signal.coin,
          isBuy: signal.positionAfter.gt(0),
          leaderVwap: signal.vwap,
          mid: market.mid,
          midAt: market.midAt,
          now,
          limitBps: driftLimitBps(signal.coin, settings),
        }),
    ],
    ['coin_lock', () => checkCoinLock(book, signal.wallet, signal.coin)],
    [
      'leader_equity',
      () =>
        leg?.kind === 'open'
          ? checkLeaderEquity(leader, now, settings.leaderEquityMaxAgeMs)
          : skip('applies to opens only, and the copy keeps its frozen ratio'),
    ],
  ];
  for (const [policy, check] of gates) {
    if (!isEntryOpen(evaluation, policy)) {
      recordSkip(evaluation, policy);
      continue;
    }
    const outcome = check();
    record(evaluation, policy, outcome);
    if (outcome.outcome === 'reject') {
      endEntry(evaluation, policy);
    }
  }
}

function evaluateSizing(
  evaluation: Evaluation,
  signal: Signal,
  context: DecisionContext,
  market: MarketView,
): EntryResult | null {
  const leg = evaluation.episode.entry;
  if (leg === null || !isEntryOpen(evaluation, 'sizing')) {
    recordSkip(evaluation, 'sizing');
    return null;
  }
  const { book, leader, settings } = context;
  const isOpen = leg.kind === 'open';
  const allocationUsd = isOpen
    ? allocationForBook(book.book, settings)
    : leg.copy.allocationUsd;
  const ratio = entryRatio(leg, leader, allocationUsd);
  if (ratio === null || market.mid === null) {
    record(
      evaluation,
      'sizing',
      ratio === null
        ? reject('leader_equity_stale', 'leader equity is unknown')
        : reject('mid_unavailable', `no mid is known for ${signal.coin}`),
    );
    endEntry(evaluation, 'sizing');
    return null;
  }
  const replacedCopyId =
    leg.kind === 'increase'
      ? leg.copy.id
      : (evaluation.episode.exit?.copy.id ?? null);
  const sizing = checkSizing({
    isOpen,
    ratio,
    leaderSize: signal.positionAfter,
    copySize: leg.kind === 'increase' ? leg.copy.size : new Decimal(0),
    mid: market.mid,
    szDecimals: market.szDecimals,
    caps: entryCaps({
      book,
      settings,
      wallet: signal.wallet,
      positionAllocationUsd: allocationUsd,
      replacedCopyId,
      isOpen,
    }),
    maxOpenCopies: settings.maxOpenCopies,
  });
  record(evaluation, 'sizing', sizing.outcome);
  if (sizing.sizing.result !== 'order') {
    endEntry(evaluation, 'sizing');
    return { leg, ratio, allocationUsd, sizing, order: null };
  }
  const isBuy = signal.positionAfter.gt(0);
  return {
    leg,
    ratio,
    allocationUsd,
    sizing,
    order: {
      isBuy,
      size: sizing.sizing.orderSize,
      limitPx: limitPrice(
        signal.vwap,
        isBuy,
        driftLimitBps(signal.coin, settings),
        market.szDecimals,
      ),
    },
  };
}

function evaluateMargin(
  evaluation: Evaluation,
  context: DecisionContext,
  market: MarketView,
  entry: EntryResult | null,
): void {
  if (
    entry === null ||
    entry.order === null ||
    !isEntryOpen(evaluation, 'margin')
  ) {
    recordSkip(evaluation, 'margin');
    return;
  }
  const { book, settings } = context;
  const leverage = exchangeLeverage(market, settings);
  const closing = evaluation.episode.exit;
  const freedMarginUsd =
    closing?.kind === 'close'
      ? closing.copy.notionalUsd.div(leverage)
      : new Decimal(0);
  const outcome = checkMargin({
    freeMarginUsd: book.freeMarginUsd.plus(freedMarginUsd),
    orderNotionalUsd: entry.order.size.mul(entry.order.limitPx),
    leverage,
    marginBuffer: settings.marginBuffer,
  });
  record(evaluation, 'margin', outcome);
  if (outcome.outcome === 'reject') {
    endEntry(evaluation, 'margin');
  }
}

function completeTrace(evaluation: Evaluation): void {
  for (const policy of POLICY_ORDER.slice(evaluation.trace.length)) {
    recordSkip(evaluation, policy);
  }
}

function newCopy(
  signal: Signal,
  book: BookName,
  entry: EntryResult,
  waitsForFill: boolean,
): NewCopy | null {
  if (entry.leg.kind !== 'open') {
    return null;
  }
  return {
    book,
    wallet: signal.wallet,
    coin: signal.coin,
    ratio: entry.ratio,
    leaderSizeAtSync: signal.positionAfter,
    leaderOpenTid: entry.leg.leaderOpenTid,
    allocationUsd: entry.allocationUsd,
    waitsForFill,
  };
}

function leaderSizeSync(
  signal: Signal,
  evaluation: Evaluation,
  exit: ExitPathCheck | null,
  entry: EntryResult | null,
  entryIntent: OrderIntent | null,
): LeaderSizeSync | null {
  const exitLeg = evaluation.episode.exit;
  if (exitLeg?.kind === 'reduce' && exit !== null && exit.order !== null) {
    return {
      copyId: exitLeg.copy.id,
      leaderSizeAtSync: signal.positionAfter,
      waitsForFill: true,
    };
  }
  if (entry === null || entry.leg.kind !== 'increase') {
    return null;
  }
  if (entryIntent !== null) {
    return {
      copyId: entry.leg.copy.id,
      leaderSizeAtSync: signal.positionAfter,
      waitsForFill: true,
    };
  }
  const isCappedWithoutOrder =
    entry.sizing.sizing.bindingCap !== null &&
    entry.sizing.sizing.result !== 'order';
  return isCappedWithoutOrder
    ? {
        copyId: entry.leg.copy.id,
        leaderSizeAtSync: signal.positionAfter,
        waitsForFill: false,
      }
    : null;
}

function buildDecision(
  signal: Signal,
  context: DecisionContext,
  evaluation: Evaluation,
  exit: ExitPathCheck | null,
  entry: EntryResult | null,
): Decision {
  completeTrace(evaluation);
  const book = context.book.book;
  const exitLeg = evaluation.episode.exit;
  const exitOrderIntent =
    exitLeg !== null && exit !== null && exit.order !== null
      ? exitIntent(book, exitLeg.copy, 'EXIT', exit.order, signal.vwap)
      : null;
  const entryOrderIntent: OrderIntent | null =
    entry !== null && entry.order !== null && evaluation.entryEndedBy === null
      ? {
          book,
          wallet: signal.wallet,
          coin: signal.coin,
          copyId: entry.leg.kind === 'increase' ? entry.leg.copy.id : null,
          purpose: 'ENTRY',
          isBuy: entry.order.isBuy,
          size: entry.order.size,
          limitPx: entry.order.limitPx,
          reduceOnly: false,
          isExactClose: false,
          referencePx: signal.vwap,
        }
      : null;
  const intents = [exitOrderIntent, entryOrderIntent].filter(
    (intent): intent is OrderIntent => intent !== null,
  );
  const isDeferredOpen = entry?.sizing.sizing.result === 'below_min_notional';
  const opensCopy =
    entry === null
      ? null
      : entryOrderIntent !== null
        ? newCopy(signal, book, entry, true)
        : isDeferredOpen
          ? newCopy(signal, book, entry, false)
          : null;
  const verdict = intents.length > 0 ? 'COPY' : 'SKIP';
  const decisive = evaluation.trace.find(
    (line) => line.outcome === 'reject' || line.outcome === 'clip',
  );
  return {
    book,
    wallet: signal.wallet,
    coin: signal.coin,
    signalKey: signal.key,
    signalSource: signal.source,
    action: evaluation.episode.action,
    verdict,
    reason:
      decisive?.reason ?? (verdict === 'COPY' ? 'copied' : 'already_at_target'),
    trace: evaluation.trace,
    positionBefore: signal.positionBefore,
    positionAfter: signal.positionAfter,
    leaderVwap: signal.vwap,
    leaderTime: signal.lastFillTime,
    receivedAt: signal.receivedAt,
    decidedAt: context.now,
    targetSize: entry?.sizing.sizing.target ?? exit?.sizing.target ?? null,
    orderSize: entryOrderIntent?.size ?? exitOrderIntent?.size ?? null,
    intents,
    closesCopyId:
      exitLeg?.kind === 'close' && exit !== null ? exitLeg.copy.id : null,
    opensCopy,
    leaderSizeSync: leaderSizeSync(
      signal,
      evaluation,
      exit,
      entry,
      entryOrderIntent,
    ),
  };
}

export function decide(
  signal: Signal,
  context: DecisionContext,
): Decision | null {
  const { book, market, leader, settings } = context;
  const episode = checkEpisode(
    signal,
    findCopy(book, signal.wallet, signal.coin),
  );
  if (episode === null) {
    return null;
  }
  const evaluation: Evaluation = {
    episode,
    policies: policiesForBook(book.book),
    trace: [],
    entryEndedBy: null,
    signalEndedBy: null,
  };

  const instrument = checkInstrument({
    coin: signal.coin,
    market,
    isEntry: episode.entry !== null,
  });
  record(evaluation, 'instrument', instrument);
  if (market === null || instrument.reason === 'unsupported_instrument') {
    evaluation.signalEndedBy = 'instrument';
    return buildDecision(signal, context, evaluation, null, null);
  }
  if (instrument.outcome === 'reject') {
    endEntry(evaluation, 'instrument');
  }

  if (isEntryOpen(evaluation, 'leader_mode')) {
    const mode = checkLeaderMode(book.book, leader);
    record(evaluation, 'leader_mode', mode);
    if (mode.outcome === 'reject') {
      endEntry(evaluation, 'leader_mode');
    }
  } else {
    recordSkip(evaluation, 'leader_mode');
  }

  if (evaluation.signalEndedBy === null) {
    record(evaluation, 'episode', episode.outcome);
    if (episode.outcome.outcome === 'reject') {
      evaluation.signalEndedBy = 'episode';
    }
  } else {
    recordSkip(evaluation, 'episode');
  }

  let exit: ExitPathCheck | null = null;
  if (evaluation.signalEndedBy === null && episode.exit !== null) {
    exit = checkExitPath({
      exit: episode.exit,
      leaderSize: signal.positionAfter,
      market,
      leaderVwap: signal.vwap,
      exitSlippageBps: settings.exitSlippageBps,
    });
    record(evaluation, 'exit_path', exit.outcome);
  } else {
    recordSkip(evaluation, 'exit_path');
  }

  evaluateEntryGates(evaluation, signal, context, market);
  const entry = evaluateSizing(evaluation, signal, context, market);
  evaluateMargin(evaluation, context, market, entry);
  return buildDecision(signal, context, evaluation, exit, entry);
}
