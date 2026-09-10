import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { buildCloseIntent, decide, readCopySettings } from './copyEngine';
import type {
  BookView,
  CopySettings,
  CopyView,
  Decision,
  DecisionContext,
  LeaderView,
  MarketView,
  OrderIntent,
  PolicyName,
  Signal,
  TraceLine,
} from './types';
import type { ServerConfig } from '../config';

const NOW = new Date('2026-04-20T12:00:00.000Z');
const LEADER = '0x1111111111111111111111111111111111111111';
const OTHER_LEADER = '0x2222222222222222222222222222222222222222';

const SETTINGS: CopySettings = {
  liveAllocationUsd: new Decimal(5_000),
  shadowAllocationUsd: new Decimal(5_000),
  signalMaxAgeMs: 15_000,
  driftLimitMajorBps: 50,
  driftLimitOtherBps: 100,
  exitSlippageBps: 300,
  leaderEquityMaxAgeMs: 900_000,
  positionCapMultiple: 3,
  grossExposureMultiple: 3,
  maxOpenCopies: 12,
  marginBuffer: 1.2,
  dailyLossLimit: 0.05,
  maxExchangeLeverage: 5,
};

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}

function signal(
  before: string,
  after: string,
  overrides: Partial<Signal> = {},
): Signal {
  return {
    key: `${LEADER}-BTC-1001`,
    wallet: LEADER,
    coin: 'BTC',
    source: 'stream',
    fillIds: [11n, 12n],
    firstTid: 1001n,
    episodeOpenTid: null,
    positionBefore: new Decimal(before),
    positionAfter: new Decimal(after),
    touchedZero: false,
    vwap: new Decimal(65_000),
    lastFillTime: ago(1_000),
    receivedAt: ago(700),
    ...overrides,
  };
}

function copy(overrides: Partial<CopyView> = {}): CopyView {
  return {
    id: 7n,
    wallet: LEADER,
    coin: 'BTC',
    size: new Decimal('0.01'),
    ratio: new Decimal('0.005'),
    leaderSizeAtSync: new Decimal(2),
    allocationUsd: new Decimal(5_000),
    notionalUsd: new Decimal(650),
    openedAt: ago(600_000),
    lastOrderAt: ago(600_000),
    ...overrides,
  };
}

function btcMarket(overrides: Partial<MarketView> = {}): MarketView {
  return {
    coin: 'BTC',
    szDecimals: 5,
    maxLeverage: 40,
    onlyIsolated: false,
    marginMode: null,
    isDelisted: false,
    mid: new Decimal(65_010),
    midAt: ago(1_000),
    ...overrides,
  };
}

function context(
  overrides: {
    book?: Partial<BookView>;
    market?: Partial<MarketView> | null;
    leader?: Partial<LeaderView>;
  } = {},
): DecisionContext {
  const bookName = overrides.book?.book ?? 'SHADOW';
  return {
    book: {
      book: bookName,
      equityUsd: new Decimal(25_000),
      dayStartEquity: bookName === 'MAIN' ? new Decimal(25_000) : null,
      freeMarginUsd: new Decimal(25_000),
      killSwitchActive: false,
      killSwitchReason: null,
      openCopies: [],
      ...overrides.book,
    },
    market: overrides.market === null ? null : btcMarket(overrides.market),
    leader: {
      wallet: LEADER,
      status: bookName === 'MAIN' ? 'LIVE' : 'SHADOW',
      isPaused: false,
      equityUsd: new Decimal(1_000_000),
      equityAt: ago(60_000),
      ...overrides.leader,
    },
    settings: SETTINGS,
    now: NOW,
  };
}

function decideOrThrow(input: Signal, decisionContext: DecisionContext) {
  const decision = decide(input, decisionContext);
  if (decision === null) {
    throw new Error('expected a decision');
  }
  return decision;
}

function outline(decision: Decision): string[] {
  return decision.trace.map((line) =>
    [line.policy, line.outcome, line.reason ?? ''].join(' ').trim(),
  );
}

function lineOf(decision: Decision, policy: PolicyName): TraceLine {
  const line = decision.trace.find((entry) => entry.policy === policy);
  if (line === undefined) {
    throw new Error(`no ${policy} line`);
  }
  return line;
}

function plain(intent: OrderIntent) {
  return {
    ...intent,
    size: intent.size.toFixed(),
    limitPx: intent.limitPx.toFixed(),
    referencePx: intent.referencePx.toFixed(),
  };
}

function text(value: Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed();
}

describe('decide', () => {
  it('stores no decision when the leader position did not change', () => {
    expect(decide(signal('2', '2'), context())).toBeNull();
  });

  it('opens a main book copy after every policy allows it', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({ book: { book: 'MAIN' } }),
    );

    expect(decision.trace).toEqual([
      {
        policy: 'instrument',
        outcome: 'allow',
        reason: null,
        detail: 'BTC is a main-dex perp with cross margin',
      },
      {
        policy: 'leader_mode',
        outcome: 'allow',
        reason: null,
        detail: 'leader is LIVE and not paused',
      },
      {
        policy: 'episode',
        outcome: 'allow',
        reason: null,
        detail: 'leader went from 0 to 2, an episode opened at tid 1001',
      },
      {
        policy: 'exit_path',
        outcome: 'skip',
        reason: null,
        detail: 'no exit in this signal',
      },
      {
        policy: 'kill_switch',
        outcome: 'allow',
        reason: null,
        detail:
          "kill switch is off and equity 25000.00 USD is 0.00% above the day's start 25000.00 USD, limit 5.00% below",
      },
      {
        policy: 'signal_age',
        outcome: 'allow',
        reason: null,
        detail: 'last fill 1000 ms before the decision, limit 15000 ms',
      },
      {
        policy: 'price_drift',
        outcome: 'allow',
        reason: null,
        detail:
          "mid 65010 is 1.5 bps worse than the leader's VWAP 65000 for a buy, limit 50 bps",
      },
      {
        policy: 'coin_lock',
        outcome: 'allow',
        reason: null,
        detail: 'no other leader holds BTC in the book',
      },
      {
        policy: 'leader_equity',
        outcome: 'allow',
        reason: null,
        detail: 'leader equity 1000000.00 USD is 60.0 s old, limit 900.0 s',
      },
      {
        policy: 'sizing',
        outcome: 'allow',
        reason: null,
        detail: 'target 0.01 at ratio 0.005, order 0.01 worth 650.10 USD',
      },
      {
        policy: 'margin',
        outcome: 'allow',
        reason: null,
        detail:
          'free margin 25000.00 USD against 1.2 times the initial margin 130.65 USD at 5x',
      },
    ]);
    expect(decision).toMatchObject({
      book: 'MAIN',
      action: 'OPEN',
      verdict: 'COPY',
      reason: 'copied',
      signalKey: `${LEADER}-BTC-1001`,
      decidedAt: NOW,
      closesCopyId: null,
      leaderSizeSync: null,
    });
    expect(decision.intents.map(plain)).toEqual([
      {
        book: 'MAIN',
        wallet: LEADER,
        coin: 'BTC',
        copyId: null,
        purpose: 'ENTRY',
        isBuy: true,
        size: '0.01',
        limitPx: '65325',
        reduceOnly: false,
        isExactClose: false,
        referencePx: '65000',
      },
    ]);
    expect(decision.opensCopy).toMatchObject({
      book: 'MAIN',
      wallet: LEADER,
      coin: 'BTC',
      leaderOpenTid: 1001n,
      waitsForFill: true,
    });
    expect(text(decision.opensCopy?.ratio)).toBe('0.005');
    expect(text(decision.opensCopy?.leaderSizeAtSync)).toBe('2');
    expect(text(decision.opensCopy?.allocationUsd)).toBe('5000');
    expect(text(decision.targetSize)).toBe('0.01');
    expect(text(decision.orderSize)).toBe('0.01');
  });

  it('increases a shadow copy toward the frozen ratio', () => {
    const held = copy();
    const decision = decideOrThrow(
      signal('2', '3', { vwap: new Decimal(65_100) }),
      context({
        book: { openCopies: [held] },
        market: { mid: new Decimal(65_110) },
      }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode allow',
      'episode allow',
      'exit_path skip',
      'kill_switch skip',
      'signal_age allow',
      'price_drift allow',
      'coin_lock skip',
      'leader_equity skip',
      'sizing allow',
      'margin skip',
    ]);
    expect(lineOf(decision, 'episode').detail).toBe(
      'leader went from 2 to 3, past the synced 2',
    );
    expect(lineOf(decision, 'kill_switch').detail).toBe(
      'not applied in the shadow book',
    );
    expect(lineOf(decision, 'leader_equity').detail).toBe(
      'applies to opens only, and the copy keeps its frozen ratio',
    );
    expect(lineOf(decision, 'sizing').detail).toBe(
      'target 0.015 at ratio 0.005, order 0.005 worth 325.55 USD',
    );
    expect(decision.action).toBe('INCREASE');
    expect(decision.verdict).toBe('COPY');
    expect(decision.intents.map(plain)).toEqual([
      expect.objectContaining({
        copyId: 7n,
        purpose: 'ENTRY',
        isBuy: true,
        size: '0.005',
        limitPx: '65425',
        referencePx: '65100',
      }),
    ]);
    expect(decision.leaderSizeSync).toEqual({
      copyId: 7n,
      leaderSizeAtSync: new Decimal(3),
      waitsForFill: true,
    });
    expect(decision.opensCopy).toBeNull();
  });

  it('reduces a copy by the leader fraction on the exit path', () => {
    const decision = decideOrThrow(
      signal('3', '1.5', { vwap: new Decimal(64_010) }),
      context({
        book: {
          openCopies: [
            copy({
              size: new Decimal('0.015'),
              leaderSizeAtSync: new Decimal(3),
            }),
          ],
        },
        market: { mid: new Decimal(64_000) },
      }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode skip',
      'episode allow',
      'exit_path allow',
      'kill_switch skip',
      'signal_age skip',
      'price_drift skip',
      'coin_lock skip',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(lineOf(decision, 'leader_mode').detail).toBe(
      'applies to entries only',
    );
    expect(lineOf(decision, 'exit_path').detail).toBe(
      'reduce the copy from 0.015 to 0.0075, sell 0.0075 reduce-only at 62080, 300 bps through the mid 64000',
    );
    expect(lineOf(decision, 'signal_age').detail).toBe(
      'skipped on the exit path',
    );
    expect(decision.action).toBe('REDUCE');
    expect(decision.intents.map(plain)).toEqual([
      {
        book: 'SHADOW',
        wallet: LEADER,
        coin: 'BTC',
        copyId: 7n,
        purpose: 'EXIT',
        isBuy: false,
        size: '0.0075',
        limitPx: '62080',
        reduceOnly: true,
        isExactClose: false,
        referencePx: '64010',
      },
    ]);
    expect(decision.leaderSizeSync).toEqual({
      copyId: 7n,
      leaderSizeAtSync: new Decimal('1.5'),
      waitsForFill: true,
    });
    expect(decision.closesCopyId).toBeNull();
    expect(text(decision.targetSize)).toBe('0.0075');
  });

  it('closes the whole copy when the leader goes flat', () => {
    const decision = decideOrThrow(
      signal('1.5', '0', { touchedZero: true }),
      context({
        book: {
          openCopies: [
            copy({
              size: new Decimal('0.0075'),
              leaderSizeAtSync: new Decimal('1.5'),
            }),
          ],
        },
        market: { mid: new Decimal(64_000) },
      }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode skip',
      'episode allow',
      'exit_path allow',
      'kill_switch skip',
      'signal_age skip',
      'price_drift skip',
      'coin_lock skip',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(lineOf(decision, 'episode').detail).toBe(
      'leader went from 1.5 to 0, so the copied episode ended',
    );
    expect(lineOf(decision, 'exit_path').detail).toBe(
      'close the whole copy, sell 0.0075 reduce-only at 62080, 300 bps through the mid 64000',
    );
    expect(decision.action).toBe('CLOSE');
    expect(decision.verdict).toBe('COPY');
    expect(decision.intents.map(plain)).toEqual([
      expect.objectContaining({
        copyId: 7n,
        purpose: 'EXIT',
        isBuy: false,
        size: '0.0075',
        reduceOnly: true,
        isExactClose: true,
      }),
    ]);
    expect(decision.closesCopyId).toBe(7n);
    expect(decision.leaderSizeSync).toBeNull();
    expect(text(decision.targetSize)).toBe('0');
  });

  it('closes then opens the other side on a flip', () => {
    const decision = decideOrThrow(
      signal('2', '-1', {
        touchedZero: true,
        episodeOpenTid: 2002n,
        vwap: new Decimal(64_900),
      }),
      context({
        book: { openCopies: [copy()] },
        market: { mid: new Decimal(64_890) },
      }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode allow',
      'episode allow',
      'exit_path allow',
      'kill_switch skip',
      'signal_age allow',
      'price_drift allow',
      'coin_lock skip',
      'leader_equity allow',
      'sizing allow',
      'margin skip',
    ]);
    expect(lineOf(decision, 'episode').detail).toBe(
      'leader went from 2 to -1, so the copied episode ended and -1 opens a new one at tid 2002',
    );
    expect(lineOf(decision, 'price_drift').detail).toBe(
      "mid 64890 is 1.5 bps worse than the leader's VWAP 64900 for a sell, limit 50 bps",
    );
    expect(decision.action).toBe('FLIP');
    expect(decision.verdict).toBe('COPY');
    expect(decision.reason).toBe('copied');
    expect(decision.intents.map(plain)).toEqual([
      expect.objectContaining({
        copyId: 7n,
        purpose: 'EXIT',
        isBuy: false,
        size: '0.01',
        limitPx: '62944',
        isExactClose: true,
      }),
      expect.objectContaining({
        copyId: null,
        purpose: 'ENTRY',
        isBuy: false,
        size: '0.005',
        limitPx: '64576',
        reduceOnly: false,
      }),
    ]);
    expect(decision.closesCopyId).toBe(7n);
    expect(decision.opensCopy).toMatchObject({
      leaderOpenTid: 2002n,
      waitsForFill: true,
    });
    expect(text(decision.opensCopy?.leaderSizeAtSync)).toBe('-1');
    expect(text(decision.targetSize)).toBe('-0.005');
  });

  it('absorbs a missed reduce when a later increase stays below the synced size', () => {
    const decision = decideOrThrow(
      signal('1', '1.5'),
      context({ book: { openCopies: [copy()] } }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode skip',
      'episode allow',
      'exit_path allow',
      'kill_switch skip',
      'signal_age skip',
      'price_drift skip',
      'coin_lock skip',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(lineOf(decision, 'episode').detail).toBe(
      'leader went from 1 to 1.5, below the synced 2',
    );
    expect(decision.action).toBe('REDUCE');
    expect(decision.intents.map(plain)).toEqual([
      expect.objectContaining({
        purpose: 'EXIT',
        isBuy: false,
        size: '0.0025',
        limitPx: '63060',
      }),
    ]);
    expect(text(decision.leaderSizeSync?.leaderSizeAtSync)).toBe('1.5');
  });

  it('closes the copy of a catch-up whose episode ended and rejects the stale reopen', () => {
    const decision = decideOrThrow(
      signal('2', '1.2', {
        source: 'catch_up',
        touchedZero: true,
        episodeOpenTid: 3003n,
        vwap: new Decimal(64_000),
        lastFillTime: ago(600_000),
      }),
      context({ book: { openCopies: [copy()] } }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode allow',
      'episode allow',
      'exit_path allow',
      'kill_switch skip',
      'signal_age reject stale_signal',
      'price_drift skip',
      'coin_lock skip',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(lineOf(decision, 'signal_age').detail).toBe(
      'last fill 600000 ms before the decision, limit 15000 ms',
    );
    expect(lineOf(decision, 'price_drift').detail).toBe(
      'not evaluated after signal_age rejected the entry',
    );
    expect(decision).toMatchObject({
      action: 'FLIP',
      verdict: 'COPY',
      reason: 'stale_signal',
      signalSource: 'catch_up',
      closesCopyId: 7n,
      opensCopy: null,
    });
    expect(decision.intents.map(plain)).toEqual([
      expect.objectContaining({
        purpose: 'EXIT',
        size: '0.01',
        limitPx: '63060',
        isExactClose: true,
      }),
    ]);
    expect(text(decision.targetSize)).toBe('0');
  });

  it('stores no decision for a catch-up whose whole episode ended without a copy', () => {
    const decision = decide(
      signal('0', '0', { source: 'catch_up', touchedZero: true }),
      context(),
    );

    expect(decision).toBeNull();
  });

  it('rejects a stale entry and opens no copy', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n, lastFillTime: ago(20_000) }),
      context(),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode allow',
      'episode allow',
      'exit_path skip',
      'kill_switch skip',
      'signal_age reject stale_signal',
      'price_drift skip',
      'coin_lock skip',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(lineOf(decision, 'sizing').detail).toBe(
      'not evaluated after signal_age rejected the signal',
    );
    expect(decision).toMatchObject({
      action: 'OPEN',
      verdict: 'SKIP',
      reason: 'stale_signal',
      intents: [],
      opensCopy: null,
      targetSize: null,
      orderSize: null,
    });
  });

  it('runs a late exit, because exits skip the signal age', () => {
    const decision = decideOrThrow(
      signal('2', '0', { touchedZero: true, lastFillTime: ago(300_000) }),
      context({ book: { openCopies: [copy()] } }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode skip',
      'episode allow',
      'exit_path allow',
      'kill_switch skip',
      'signal_age skip',
      'price_drift skip',
      'coin_lock skip',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(decision.verdict).toBe('COPY');
    expect(decision.intents).toHaveLength(1);
    expect(decision.intents[0].isExactClose).toBe(true);
  });

  it('rejects an entry when the mid ran past the drift limit', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({ market: { mid: new Decimal(65_400) } }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode allow',
      'episode allow',
      'exit_path skip',
      'kill_switch skip',
      'signal_age allow',
      'price_drift reject price_drift',
      'coin_lock skip',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(lineOf(decision, 'price_drift').detail).toBe(
      "mid 65400 is 61.5 bps worse than the leader's VWAP 65000 for a buy, limit 50 bps",
    );
    expect(decision.verdict).toBe('SKIP');
    expect(decision.reason).toBe('price_drift');
  });

  it('rejects an entry on a mid older than 10 s', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({ market: { midAt: ago(11_000) } }),
    );

    expect(lineOf(decision, 'price_drift')).toEqual({
      policy: 'price_drift',
      outcome: 'reject',
      reason: 'mid_unavailable',
      detail: 'the mid of BTC is 11000 ms old, limit 10000 ms',
    });
    expect(decision.verdict).toBe('SKIP');
    expect(decision.reason).toBe('mid_unavailable');
    expect(decision.opensCopy).toBeNull();
  });

  it('accepts an entry on a mid 9 s old', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({ market: { midAt: ago(9_000) } }),
    );

    expect(lineOf(decision, 'price_drift').outcome).toBe('allow');
    expect(decision.verdict).toBe('COPY');
  });

  it('still closes a copy on a mid older than 10 s', () => {
    const decision = decideOrThrow(
      signal('2', '0', { touchedZero: true }),
      context({
        book: { openCopies: [copy()] },
        market: { midAt: ago(11_000) },
      }),
    );

    expect(decision.verdict).toBe('COPY');
    expect(decision.intents.map(plain)).toEqual([
      expect.objectContaining({
        purpose: 'EXIT',
        isBuy: false,
        size: '0.01',
        limitPx: '63060',
        isExactClose: true,
      }),
    ]);
  });

  it('rejects an open on a coin another leader holds in the main book', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({
        book: {
          book: 'MAIN',
          openCopies: [
            copy({
              id: 9n,
              wallet: OTHER_LEADER,
              notionalUsd: new Decimal(1_300),
            }),
          ],
        },
      }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode allow',
      'episode allow',
      'exit_path skip',
      'kill_switch allow',
      'signal_age allow',
      'price_drift allow',
      'coin_lock reject coin_owned_by_other_leader',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(lineOf(decision, 'coin_lock').detail).toBe(
      `BTC is held by a copy of ${OTHER_LEADER}`,
    );
    expect(decision.reason).toBe('coin_owned_by_other_leader');
  });

  it('lets two leaders hold one coin in the shadow book', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({
        book: { openCopies: [copy({ id: 9n, wallet: OTHER_LEADER })] },
      }),
    );

    expect(decision.verdict).toBe('COPY');
    expect(lineOf(decision, 'coin_lock').outcome).toBe('skip');
  });

  it('blocks main book entries once equity falls 5% below the day start', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({
        book: { book: 'MAIN', equityUsd: new Decimal(23_700) },
      }),
    );

    expect(outline(decision)).toEqual([
      'instrument allow',
      'leader_mode allow',
      'episode allow',
      'exit_path skip',
      'kill_switch reject kill_switch_active',
      'signal_age skip',
      'price_drift skip',
      'coin_lock skip',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(lineOf(decision, 'kill_switch').detail).toBe(
      "equity 23700.00 USD is 5.20% below the day's start 25000.00 USD, limit 5.00% below",
    );
    expect(decision.verdict).toBe('SKIP');
    expect(decision.reason).toBe('kill_switch_active');
  });

  it('still exits the main book while the kill switch is on', () => {
    const decision = decideOrThrow(
      signal('2', '0', { touchedZero: true }),
      context({
        book: {
          book: 'MAIN',
          killSwitchActive: true,
          killSwitchReason: 'set from the dashboard',
          openCopies: [copy()],
        },
      }),
    );

    expect(lineOf(decision, 'kill_switch')).toEqual({
      policy: 'kill_switch',
      outcome: 'skip',
      reason: null,
      detail: 'skipped on the exit path',
    });
    expect(decision.verdict).toBe('COPY');
    expect(decision.closesCopyId).toBe(7n);
  });

  it('ignores the kill switch in the shadow book', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({ book: { killSwitchActive: true } }),
    );

    expect(decision.verdict).toBe('COPY');
  });

  it('keeps exits flowing for a paused leader that flips', () => {
    const decision = decideOrThrow(
      signal('2', '-1', { touchedZero: true, episodeOpenTid: 2002n }),
      context({
        book: { openCopies: [copy()] },
        leader: { isPaused: true },
      }),
    );

    expect(outline(decision).slice(0, 6)).toEqual([
      'instrument allow',
      'leader_mode reject leader_paused',
      'episode allow',
      'exit_path allow',
      'kill_switch skip',
      'signal_age skip',
    ]);
    expect(lineOf(decision, 'signal_age').detail).toBe(
      'not evaluated after leader_mode rejected the entry',
    );
    expect(decision).toMatchObject({
      verdict: 'COPY',
      reason: 'leader_paused',
      closesCopyId: 7n,
      opensCopy: null,
    });
    expect(decision.intents.map((intent) => intent.purpose)).toEqual(['EXIT']);
  });

  it('rejects every policy after an unknown market', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({ market: null }),
    );

    expect(outline(decision)).toEqual([
      'instrument reject unsupported_instrument',
      'leader_mode skip',
      'episode skip',
      'exit_path skip',
      'kill_switch skip',
      'signal_age skip',
      'price_drift skip',
      'coin_lock skip',
      'leader_equity skip',
      'sizing skip',
      'margin skip',
    ]);
    expect(lineOf(decision, 'episode').detail).toBe(
      'not evaluated after instrument rejected the signal',
    );
    expect(decision.reason).toBe('unsupported_instrument');
  });

  it('refuses entries on an isolated-only market but closes copies there', () => {
    const isolated = { onlyIsolated: true };
    const increase = decideOrThrow(
      signal('2', '3'),
      context({ book: { openCopies: [copy()] }, market: isolated }),
    );
    const close = decideOrThrow(
      signal('2', '0', { touchedZero: true }),
      context({ book: { openCopies: [copy()] }, market: isolated }),
    );

    expect(increase.reason).toBe('isolated_only_market');
    expect(increase.intents).toEqual([]);
    expect(close.verdict).toBe('COPY');
    expect(lineOf(close, 'instrument').outcome).toBe('allow');
  });

  it('opens a copy at size 0 when the open is under the minimum', () => {
    const decision = decideOrThrow(
      signal('0', '0.02', { episodeOpenTid: 1001n }),
      context(),
    );

    expect(decision.verdict).toBe('SKIP');
    expect(decision.reason).toBe('below_min_notional');
    expect(decision.intents).toEqual([]);
    expect(decision.opensCopy).toMatchObject({ waitsForFill: false });
    expect(text(decision.opensCopy?.leaderSizeAtSync)).toBe('0.02');
    expect(text(decision.targetSize)).toBe('0.0001');
  });

  it('keeps the synced size on a deferred increase', () => {
    const decision = decideOrThrow(
      signal('2', '2.02'),
      context({ book: { openCopies: [copy()] } }),
    );

    expect(decision.reason).toBe('below_min_notional');
    expect(decision.leaderSizeSync).toBeNull();
  });

  it('moves the synced size at once when a cap leaves no room', () => {
    const capped = decideOrThrow(
      signal('2', '3'),
      context({
        book: {
          openCopies: [
            copy(),
            copy({
              id: 8n,
              coin: 'ETH',
              notionalUsd: new Decimal(14_500),
            }),
          ],
        },
      }),
    );

    expect(capped.verdict).toBe('SKIP');
    expect(capped.reason).toBe('cap_reached');
    expect(lineOf(capped, 'sizing').detail).toBe(
      "the per-leader cap with 500.00 USD left leaves no room above the copy's 0.01",
    );
    expect(capped.leaderSizeSync).toEqual({
      copyId: 7n,
      leaderSizeAtSync: new Decimal(3),
      waitsForFill: false,
    });
  });

  it('clips an open to the per-position cap and still copies it', () => {
    const decision = decideOrThrow(
      signal('0', '100', { episodeOpenTid: 1001n }),
      context(),
    );

    expect(lineOf(decision, 'sizing')).toMatchObject({
      outcome: 'clip',
      reason: 'cap_reached',
    });
    expect(decision.verdict).toBe('COPY');
    expect(decision.reason).toBe('cap_reached');
    expect(text(decision.intents[0].size)).toBe('0.23073');
    expect(text(decision.opensCopy?.ratio)).toBe('0.005');
  });

  it('caps the main book at the open copies limit', () => {
    const others = Array.from({ length: 12 }, (_, index) =>
      copy({
        id: BigInt(100 + index),
        wallet: OTHER_LEADER,
        coin: `COIN${index}`,
        notionalUsd: new Decimal(100),
      }),
    );
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({ book: { book: 'MAIN', openCopies: others } }),
    );

    expect(decision.reason).toBe('cap_reached');
    expect(lineOf(decision, 'sizing').detail).toContain(
      'limit of 12 open copies',
    );
  });

  it('rejects a main book entry without enough free margin', () => {
    const decision = decideOrThrow(
      signal('0', '2', { episodeOpenTid: 1001n }),
      context({ book: { book: 'MAIN', freeMarginUsd: new Decimal(100) } }),
    );

    expect(lineOf(decision, 'margin')).toMatchObject({
      outcome: 'reject',
      reason: 'insufficient_margin',
    });
    expect(decision.verdict).toBe('SKIP');
    expect(decision.opensCopy).toBeNull();
  });

  it('counts the margin a flip frees before it checks the new side', () => {
    const decision = decideOrThrow(
      signal('2', '-2', { touchedZero: true, episodeOpenTid: 2002n }),
      context({
        book: {
          book: 'MAIN',
          freeMarginUsd: new Decimal(50),
          openCopies: [copy({ notionalUsd: new Decimal(650) })],
        },
      }),
    );

    expect(lineOf(decision, 'margin').outcome).toBe('allow');
    expect(decision.intents.map((intent) => intent.purpose)).toEqual([
      'EXIT',
      'ENTRY',
    ]);
  });

  it('closes a copy without size without an order', () => {
    const decision = decideOrThrow(
      signal('2', '0', { touchedZero: true }),
      context({
        book: { openCopies: [copy({ size: new Decimal(0) })] },
      }),
    );

    expect(decision).toMatchObject({
      action: 'CLOSE',
      verdict: 'SKIP',
      reason: 'already_at_target',
      intents: [],
      closesCopyId: 7n,
    });
  });

  it('skips a leader move on an episode it never copied', () => {
    const decision = decideOrThrow(signal('1', '2'), context());

    expect(decision.reason).toBe('position_not_copied');
    expect(lineOf(decision, 'leader_mode').detail).toBe(
      'applies to entries only',
    );
    expect(lineOf(decision, 'exit_path').detail).toBe(
      'not evaluated after episode rejected the signal',
    );
  });
});

describe('buildCloseIntent', () => {
  it('prices a reconciliation close like a fast path close', () => {
    const intent = buildCloseIntent({
      book: 'MAIN',
      copy: copy({ size: new Decimal('-0.02') }),
      purpose: 'RECONCILE',
      market: btcMarket(),
      referencePx: new Decimal(65_010),
      exitSlippageBps: 300,
    });

    expect(intent === null ? null : plain(intent)).toEqual({
      book: 'MAIN',
      wallet: LEADER,
      coin: 'BTC',
      copyId: 7n,
      purpose: 'RECONCILE',
      isBuy: true,
      size: '0.02',
      limitPx: '66960',
      reduceOnly: true,
      isExactClose: true,
      referencePx: '65010',
    });
  });

  it('has nothing to send for a copy without size', () => {
    const intent = buildCloseIntent({
      book: 'SHADOW',
      copy: copy({ size: new Decimal(0) }),
      purpose: 'STOP',
      market: btcMarket(),
      referencePx: new Decimal(65_010),
      exitSlippageBps: 300,
    });

    expect(intent).toBeNull();
  });
});

describe('readCopySettings', () => {
  it('maps the server configuration onto the engine settings', () => {
    const settings = readCopySettings({
      LIVE_ALLOCATION_USD: 5_000,
      SHADOW_ALLOCATION_USD: 2_500,
      SIGNAL_MAX_AGE_MS: 15_000,
      DRIFT_LIMIT_MAJOR_BPS: 50,
      DRIFT_LIMIT_OTHER_BPS: 100,
      EXIT_SLIPPAGE_BPS: 300,
      LEADER_EQUITY_MAX_AGE_MS: 900_000,
      POSITION_CAP_MULTIPLE: 3,
      GROSS_EXPOSURE_MULTIPLE: 3,
      MAX_OPEN_COPIES: 12,
      MARGIN_BUFFER: 1.2,
      DAILY_LOSS_LIMIT: 0.05,
      MAX_EXCHANGE_LEVERAGE: 5,
    } as ServerConfig);

    expect(settings).toEqual({
      ...SETTINGS,
      shadowAllocationUsd: new Decimal(2_500),
    });
  });
});
