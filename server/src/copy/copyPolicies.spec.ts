import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
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
  MAIN_BOOK_POLICIES,
  SHADOW_BOOK_POLICIES,
} from './copyPolicies';
import type {
  BookView,
  CopySettings,
  CopyView,
  LeaderView,
  MarketView,
  Signal,
} from './types';

const NOW = new Date('2026-04-20T12:00:00.000Z');
const LEADER = '0x1111111111111111111111111111111111111111';
const OTHER_LEADER = '0x2222222222222222222222222222222222222222';

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}

function text(value: Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed();
}

function market(overrides: Partial<MarketView> = {}): MarketView {
  return {
    coin: 'BTC',
    szDecimals: 5,
    maxLeverage: 40,
    onlyIsolated: false,
    marginMode: null,
    isDelisted: false,
    mid: new Decimal(65_000),
    midAt: ago(1_000),
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

function book(overrides: Partial<BookView> = {}): BookView {
  return {
    book: 'MAIN',
    equityUsd: new Decimal(25_000),
    dayStartEquity: new Decimal(25_000),
    freeMarginUsd: new Decimal(25_000),
    killSwitchActive: false,
    killSwitchReason: null,
    openCopies: [],
    ...overrides,
  };
}

function leader(overrides: Partial<LeaderView> = {}): LeaderView {
  return {
    wallet: LEADER,
    status: 'LIVE',
    isPaused: false,
    equityUsd: new Decimal(1_000_000),
    equityAt: ago(60_000),
    ...overrides,
  };
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
    fillIds: [1n],
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

describe('book policy lists', () => {
  it('runs every policy of the table in order for the main book', () => {
    expect(MAIN_BOOK_POLICIES).toEqual([
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
    ]);
  });

  it('leaves the kill switch, the coin lock and the margin out of the shadow book', () => {
    expect(SHADOW_BOOK_POLICIES).toEqual(
      MAIN_BOOK_POLICIES.filter(
        (policy) => !['kill_switch', 'coin_lock', 'margin'].includes(policy),
      ),
    );
  });
});

describe('checkInstrument', () => {
  it.each([
    ['a cross market entry', 'BTC', market(), true, 'allow', null],
    [
      'a missing market',
      'BTC',
      null,
      false,
      'reject',
      'unsupported_instrument',
    ],
    [
      'a delisted market',
      'BTC',
      market({ isDelisted: true }),
      false,
      'reject',
      'unsupported_instrument',
    ],
    [
      'a HIP-3 coin',
      'xyz:MU',
      market(),
      true,
      'reject',
      'unsupported_instrument',
    ],
    ['a spot pair', '@107', market(), true, 'reject', 'unsupported_instrument'],
    [
      'an outcome market',
      '#90',
      market(),
      true,
      'reject',
      'unsupported_instrument',
    ],
    [
      'an isolated-only entry',
      'BTC',
      market({ onlyIsolated: true }),
      true,
      'reject',
      'isolated_only_market',
    ],
    [
      'a strict isolated entry',
      'BTC',
      market({ marginMode: 'strictIsolated' }),
      true,
      'reject',
      'isolated_only_market',
    ],
    [
      'a no cross entry',
      'BTC',
      market({ marginMode: 'noCross' }),
      true,
      'reject',
      'isolated_only_market',
    ],
    [
      'an exit on an isolated-only market',
      'BTC',
      market({ onlyIsolated: true }),
      false,
      'allow',
      null,
    ],
  ])('judges %s', (_name, coin, marketView, isEntry, outcome, reason) => {
    const result = checkInstrument({ coin, market: marketView, isEntry });

    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(reason);
  });
});

describe('checkLeaderMode', () => {
  it.each([
    ['MAIN', 'LIVE', false, 'allow', null],
    ['MAIN', 'SHADOW', false, 'reject', 'leader_not_copied'],
    ['MAIN', 'RETIRED', false, 'reject', 'leader_not_copied'],
    ['SHADOW', 'SHADOW', false, 'allow', null],
    ['SHADOW', 'LIVE', false, 'reject', 'leader_not_copied'],
    ['SHADOW', 'CANDIDATE', false, 'reject', 'leader_not_copied'],
    ['MAIN', 'LIVE', true, 'reject', 'leader_paused'],
    ['SHADOW', 'SHADOW', true, 'reject', 'leader_paused'],
  ] as const)(
    'in the %s book judges a %s leader with paused=%s',
    (bookName, status, isPaused, outcome, reason) => {
      const result = checkLeaderMode(bookName, leader({ status, isPaused }));

      expect(result.outcome).toBe(outcome);
      expect(result.reason).toBe(reason);
    },
  );
});

describe('checkEpisode', () => {
  const synced = (size: string, leaderSize: string) =>
    copy({
      size: new Decimal(size),
      leaderSizeAtSync: new Decimal(leaderSize),
    });

  it.each([
    {
      name: 'an open from flat without a copy',
      signal: signal('0', '2', { episodeOpenTid: 1001n }),
      copy: null,
      expected: ['OPEN', 'allow', null, null, 'open'],
    },
    {
      name: 'an increase of an episode that began earlier',
      signal: signal('1', '2'),
      copy: null,
      expected: ['INCREASE', 'reject', 'position_not_copied', null, null],
    },
    {
      name: 'a close of an episode that began earlier',
      signal: signal('2', '0', { touchedZero: true }),
      copy: null,
      expected: ['CLOSE', 'reject', 'position_not_copied', null, null],
    },
    {
      name: 'a flip of an uncopied episode into a new one',
      signal: signal('2', '-1', { touchedZero: true, episodeOpenTid: 1002n }),
      copy: null,
      expected: ['OPEN', 'allow', null, null, 'open'],
    },
    {
      name: 'an increase past the synced size',
      signal: signal('2', '3'),
      copy: synced('0.01', '2'),
      expected: ['INCREASE', 'allow', null, null, 'increase'],
    },
    {
      name: 'a reduce below the synced size',
      signal: signal('3', '1'),
      copy: synced('0.01', '2'),
      expected: ['REDUCE', 'allow', null, 'reduce', null],
    },
    {
      name: 'a close',
      signal: signal('2', '0', { touchedZero: true }),
      copy: synced('0.01', '2'),
      expected: ['CLOSE', 'allow', null, 'close', null],
    },
    {
      name: 'a flip',
      signal: signal('2', '-1', { touchedZero: true, episodeOpenTid: 1002n }),
      copy: synced('0.01', '2'),
      expected: ['FLIP', 'allow', null, 'close', 'open'],
    },
    {
      name: 'a reopen on the same side through zero',
      signal: signal('2', '1.5', { touchedZero: true, episodeOpenTid: 1002n }),
      copy: synced('0.01', '2'),
      expected: ['FLIP', 'allow', null, 'close', 'open'],
    },
    {
      name: 'a signal that starts from flat while a copy is open',
      signal: signal('0', '1', { episodeOpenTid: 1002n }),
      copy: synced('0.01', '2'),
      expected: ['FLIP', 'allow', null, 'close', 'open'],
    },
    {
      name: 'a leader found on the other side of the copy',
      signal: signal('-1', '-2'),
      copy: synced('0.01', '2'),
      expected: ['CLOSE', 'allow', null, 'close', null],
    },
    {
      name: 'an increase after a missed reduce',
      signal: signal('1', '1.5'),
      copy: synced('0.01', '2'),
      expected: ['REDUCE', 'allow', null, 'reduce', null],
    },
    {
      name: 'a leader reduce that stays above a deferred sync point',
      signal: signal('2', '1.5'),
      copy: synced('0.005', '1'),
      expected: ['REDUCE', 'reject', 'already_at_target', null, null],
    },
    {
      name: 'a return to the synced size',
      signal: signal('1', '2'),
      copy: synced('0.01', '2'),
      expected: ['INCREASE', 'reject', 'already_at_target', null, null],
    },
    {
      name: 'a short increase',
      signal: signal('-2', '-3'),
      copy: synced('-0.01', '-2'),
      expected: ['INCREASE', 'allow', null, null, 'increase'],
    },
  ])('plans $name', ({ signal: input, copy: held, expected }) => {
    const plan = checkEpisode(input, held);

    expect([
      plan?.action,
      plan?.outcome.outcome,
      plan?.outcome.reason,
      plan?.exit?.kind ?? null,
      plan?.entry?.kind ?? null,
    ]).toEqual(expected);
  });

  it.each([
    ['an unchanged position', signal('2', '2'), copy()],
    ['an unchanged position without a copy', signal('2', '2'), null],
    [
      'a whole episode inside the signal without a copy',
      signal('0', '0', { touchedZero: true }),
      null,
    ],
  ])('stores no decision for %s', (_name, input, held) => {
    expect(checkEpisode(input, held)).toBeNull();
  });

  it('keeps the episode open tid for a new copy', () => {
    const plan = checkEpisode(
      signal('0', '2', { episodeOpenTid: 4242n }),
      null,
    );

    expect(plan?.entry).toEqual({ kind: 'open', leaderOpenTid: 4242n });
  });
});

describe('checkExitPath', () => {
  const exitPath = (
    kind: 'close' | 'reduce',
    held: CopyView,
    leaderSize: string,
    marketView: MarketView = market(),
  ) =>
    checkExitPath({
      exit: { kind, copy: held },
      leaderSize: new Decimal(leaderSize),
      market: marketView,
      leaderVwap: new Decimal(64_000),
      exitSlippageBps: 300,
    });

  it.each([
    [
      'closes a long',
      'close',
      '0.01',
      '2',
      '0',
      'allow',
      null,
      false,
      '0.01',
      '63050',
    ],
    [
      'closes a short',
      'close',
      '-0.01',
      '-2',
      '0',
      'allow',
      null,
      true,
      '0.01',
      '66950',
    ],
    [
      'reduces a long',
      'reduce',
      '0.03',
      '4.5',
      '3',
      'allow',
      null,
      false,
      '0.01',
      '63050',
    ],
    [
      'defers a reduce under the minimum',
      'reduce',
      '0.01',
      '2',
      '1.999',
      'reject',
      'below_min_notional',
      null,
      null,
      null,
    ],
  ] as const)(
    '%s',
    (
      _name,
      kind,
      size,
      synced,
      leaderAfter,
      outcome,
      reason,
      isBuy,
      orderSize,
      limitPx,
    ) => {
      const result = exitPath(
        kind,
        copy({
          size: new Decimal(size),
          leaderSizeAtSync: new Decimal(synced),
        }),
        leaderAfter,
      );

      expect(result.outcome.outcome).toBe(outcome);
      expect(result.outcome.reason).toBe(reason);
      expect(result.order?.isBuy ?? null).toBe(isBuy);
      expect(text(result.order?.size)).toBe(orderSize);
      expect(text(result.order?.limitPx)).toBe(limitPx);
    },
  );

  it('marks a close as exact', () => {
    const result = exitPath('close', copy(), '0');

    expect(result.order?.isExactClose).toBe(true);
  });

  it('closes a copy without size without an order', () => {
    const result = exitPath('close', copy({ size: new Decimal(0) }), '0');

    expect(result.outcome.outcome).toBe('allow');
    expect(result.order).toBeNull();
  });

  it('needs no reduce for a copy without size', () => {
    const result = exitPath('reduce', copy({ size: new Decimal(0) }), '1');

    expect(result.outcome.reason).toBe('already_at_target');
    expect(result.order).toBeNull();
  });

  it('prices from the leader VWAP when no mid is known', () => {
    const result = exitPath('close', copy(), '0', market({ mid: null }));

    expect(text(result.order?.limitPx)).toBe('62080');
    expect(result.outcome.detail).toContain('no mid is known');
  });
});

describe('checkKillSwitch', () => {
  it.each([
    ['a manual switch with a reason', true, 'operator', '25000', 'reject'],
    ['a manual switch without a reason', true, null, '25000', 'reject'],
    ['equity exactly 5% down', false, null, '23750', 'reject'],
    ['equity just inside the limit', false, null, '23750.01', 'allow'],
    ['equity above the start', false, null, '26000', 'allow'],
  ])('judges %s', (_name, active, reason, equity, outcome) => {
    const result = checkKillSwitch(
      book({
        killSwitchActive: active,
        killSwitchReason: reason,
        equityUsd: new Decimal(equity),
      }),
      0.05,
    );

    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(
      outcome === 'reject' ? 'kill_switch_active' : null,
    );
  });

  it('only checks the manual switch when the day has no starting equity', () => {
    const result = checkKillSwitch(
      book({ dayStartEquity: null, equityUsd: new Decimal(1) }),
      0.05,
    );

    expect(result.outcome).toBe('allow');
  });

  it('names the switch reason', () => {
    const result = checkKillSwitch(
      book({ killSwitchActive: true, killSwitchReason: 'daily_loss_limit' }),
      0.05,
    );

    expect(result.detail).toBe('kill switch is on: daily_loss_limit');
  });
});

describe('checkSignalAge', () => {
  it.each([
    [0, 'allow'],
    [15_000, 'allow'],
    [15_001, 'reject'],
    [600_000, 'reject'],
  ])('judges a last fill %i ms old', (ageMs, outcome) => {
    const result = checkSignalAge(ago(ageMs), NOW, 15_000);

    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(outcome === 'reject' ? 'stale_signal' : null);
  });
});

describe('checkPriceDrift', () => {
  it.each([
    ['a buy 40 bps worse', true, '65260', 50, 'allow', null],
    ['a buy 60 bps worse', true, '65390', 50, 'reject', 'price_drift'],
    ['a buy below the leader', true, '64000', 50, 'allow', null],
    ['a sell 60 bps worse', false, '64610', 50, 'reject', 'price_drift'],
    ['a sell above the leader', false, '66000', 50, 'allow', null],
    [
      'a sell 60 bps worse on a wider limit',
      false,
      '64610',
      100,
      'allow',
      null,
    ],
    ['a buy exactly at the limit', true, '65325', 50, 'allow', null],
    ['a buy without a mid', true, null, 50, 'reject', 'mid_unavailable'],
  ])('judges %s', (_name, isBuy, mid, limitBps, outcome, reason) => {
    const result = checkPriceDrift({
      coin: 'BTC',
      isBuy,
      leaderVwap: new Decimal(65_000),
      mid: mid === null ? null : new Decimal(mid),
      midAt: ago(1_000),
      now: NOW,
      limitBps,
    });

    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(reason);
  });

  it.each([
    ['9 s old', 9_000, 'allow', null],
    ['exactly 10 s old', 10_000, 'allow', null],
    ['11 s old', 11_000, 'reject', 'mid_unavailable'],
    ['of unknown age', null, 'reject', 'mid_unavailable'],
  ])('judges an entry on a mid %s', (_name, ageMs, outcome, reason) => {
    const result = checkPriceDrift({
      coin: 'BTC',
      isBuy: true,
      leaderVwap: new Decimal(65_000),
      mid: new Decimal(65_010),
      midAt: ageMs === null ? null : ago(ageMs),
      now: NOW,
      limitBps: 50,
    });

    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(reason);
  });

  it('uses the tight limit for BTC and ETH only', () => {
    const settings = {
      driftLimitMajorBps: 50,
      driftLimitOtherBps: 100,
    } as CopySettings;

    expect(
      ['BTC', 'ETH', 'SOL', 'HYPE'].map((coin) =>
        driftLimitBps(coin, settings),
      ),
    ).toEqual([50, 50, 100, 100]);
  });
});

describe('checkCoinLock', () => {
  it.each([
    ['a free coin', [], 'allow', null],
    ['a coin held by the same leader', [copy()], 'allow', null],
    [
      'a coin held by another leader',
      [copy({ wallet: OTHER_LEADER })],
      'reject',
      'coin_owned_by_other_leader',
    ],
    [
      'another leader on another coin',
      [copy({ wallet: OTHER_LEADER, coin: 'ETH' })],
      'allow',
      null,
    ],
  ])('judges %s', (_name, openCopies, outcome, reason) => {
    const result = checkCoinLock(book({ openCopies }), LEADER, 'BTC');

    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(reason);
  });
});

describe('checkLeaderEquity', () => {
  it.each([
    ['fresh equity', '1000000', 60_000, 'allow'],
    ['equity exactly at the age limit', '1000000', 900_000, 'allow'],
    ['stale equity', '1000000', 900_001, 'reject'],
    ['unknown equity', null, 60_000, 'reject'],
    ['zero equity', '0', 60_000, 'reject'],
    ['negative equity', '-5', 60_000, 'reject'],
  ])('judges %s', (_name, equity, ageMs, outcome) => {
    const result = checkLeaderEquity(
      leader({
        equityUsd: equity === null ? null : new Decimal(equity),
        equityAt: ago(ageMs),
      }),
      NOW,
      900_000,
    );

    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(
      outcome === 'reject' ? 'leader_equity_stale' : null,
    );
  });
});

describe('checkSizing', () => {
  const sizing = (
    leaderSize: string,
    copySize: string,
    remainingUsd: string,
    isOpen = false,
  ) =>
    checkSizing({
      isOpen,
      ratio: new Decimal('0.005'),
      leaderSize: new Decimal(leaderSize),
      copySize: new Decimal(copySize),
      mid: new Decimal(65_000),
      szDecimals: 5,
      caps: [
        { name: 'position', remainingUsd: new Decimal(15_000) },
        { name: 'gross', remainingUsd: new Decimal(remainingUsd) },
      ],
      maxOpenCopies: 12,
    });

  it.each([
    ['an order within the caps', '3', '0.01', '75000', false, 'allow', null],
    [
      'an order clipped by a cap',
      '100',
      '0',
      '13000',
      true,
      'clip',
      'cap_reached',
    ],
    [
      'a cap with no room left',
      '3',
      '0.01',
      '-100',
      false,
      'reject',
      'cap_reached',
    ],
    [
      'a target the copy already holds',
      '2',
      '0.01',
      '75000',
      false,
      'reject',
      'already_at_target',
    ],
    [
      'an open under the minimum',
      '0.02',
      '0',
      '75000',
      true,
      'reject',
      'below_min_notional',
    ],
    [
      'an increase under the minimum',
      '2.02',
      '0.01',
      '75000',
      false,
      'reject',
      'below_min_notional',
    ],
  ])(
    'judges %s',
    (_name, leaderSize, copySize, remaining, isOpen, outcome, reason) => {
      const result = sizing(leaderSize, copySize, remaining, isOpen);

      expect(result.outcome.outcome).toBe(outcome);
      expect(result.outcome.reason).toBe(reason);
    },
  );

  it('describes a deferred open as a size 0 copy', () => {
    const result = sizing('0.02', '0', '75000', true);

    expect(result.outcome.detail).toContain('the copy opens at size 0');
  });

  it('names the open copies limit', () => {
    const result = checkSizing({
      isOpen: true,
      ratio: new Decimal('0.005'),
      leaderSize: new Decimal(2),
      copySize: new Decimal(0),
      mid: new Decimal(65_000),
      szDecimals: 5,
      caps: [{ name: 'open_copies', remainingUsd: new Decimal(0) }],
      maxOpenCopies: 12,
    });

    expect(result.outcome.reason).toBe('cap_reached');
    expect(result.outcome.detail).toContain('limit of 12 open copies');
  });
});

describe('checkMargin', () => {
  it.each([
    ['enough free margin', '200', 'allow'],
    ['exactly the buffered margin', '156', 'allow'],
    ['too little free margin', '155.99', 'reject'],
  ])('judges %s', (_name, freeMargin, outcome) => {
    const result = checkMargin({
      freeMarginUsd: new Decimal(freeMargin),
      orderNotionalUsd: new Decimal(650),
      leverage: 5,
      marginBuffer: 1.2,
    });

    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(
      outcome === 'reject' ? 'insufficient_margin' : null,
    );
  });
});
