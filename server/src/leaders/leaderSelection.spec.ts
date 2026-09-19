import { describe, expect, it } from 'vitest';
import {
  isRetiring,
  type LeaderEvidence,
  type LeaderRecord,
  listPromotionGaps,
  planSelection,
  readScoreInput,
  type RunScore,
  type SelectionSettings,
  smoothScore,
} from './leaderSelection';

const NOW = new Date('2026-04-20T02:30:00.000Z');
const DAY_MS = 86_400_000;

const SETTINGS: SelectionSettings = {
  trackedTarget: 2,
  streakRuns: 3,
  maxLiveLeaders: 1,
  promotionMode: 'auto',
};

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function leader(
  address: string,
  overrides: Partial<LeaderRecord> = {},
): LeaderRecord {
  return {
    address,
    status: 'CANDIDATE',
    source: 'LEADERBOARD',
    score: null,
    scoredAt: null,
    topStreak: 0,
    missStreak: 0,
    isPaused: false,
    statusReason: null,
    trackedSince: null,
    liveSince: null,
    retiredAt: null,
    ...overrides,
  };
}

function shadow(
  address: string,
  overrides: Partial<LeaderRecord> = {},
): LeaderRecord {
  return leader(address, {
    status: 'SHADOW',
    score: 0.5,
    trackedSince: daysAgo(5),
    ...overrides,
  });
}

function passed(walletAddress: string, composite: number): RunScore {
  return { walletAddress, passed: true, composite, gateFailures: [] };
}

function failed(walletAddress: string, ...gateFailures: string[]): RunScore {
  return { walletAddress, passed: false, composite: null, gateFailures };
}

function evidence(overrides: Partial<LeaderEvidence> = {}): LeaderEvidence {
  return {
    hasOpenCopies: false,
    lastFillAt: daysAgo(1),
    shadow: null,
    live: null,
    ...overrides,
  };
}

function readyShadow(): LeaderEvidence {
  return evidence({
    shadow: {
      closedCopies: 12,
      netPnlUsd: 240,
      returnOnAllocation: 0.048,
      maxDrawdown: -0.04,
      rejectionShare: 0.2,
    },
  });
}

function select(
  leaders: LeaderRecord[],
  scores: RunScore[],
  evidenceByAddress: Record<string, LeaderEvidence> = {},
  settings: Partial<SelectionSettings> = {},
) {
  const changes = planSelection({
    now: NOW,
    settings: { ...SETTINGS, ...settings },
    leaders,
    evidence: new Map(Object.entries(evidenceByAddress)),
    scores,
  });
  return new Map(changes.map((change) => [change.before.address, change]));
}

describe('smoothScore', () => {
  it('starts from the first input and then weights new inputs by 0.3', () => {
    expect(smoothScore(null, 0.8)).toBe(0.8);
    expect(smoothScore(0.8, 0.4)).toBeCloseTo(0.3 * 0.4 + 0.7 * 0.8, 12);
  });
});

describe('readScoreInput', () => {
  it.each<[string, RunScore | undefined, number | null]>([
    ['a stage-three passer', passed('0xa', 0.62), 0.62],
    ['a failed gate', failed('0xa', 'short_holds'), 0],
    [
      'a stage-two passer that missed stage three',
      { walletAddress: '0xa', passed: true, composite: null, gateFailures: [] },
      null,
    ],
    ['a wallet missing from the run', undefined, null],
  ])('reads %s', (_, score, input) => {
    expect(readScoreInput(score)).toBe(input);
  });
});

describe('planSelection scores', () => {
  it('starts the average at the first final composite and stamps the run time', () => {
    const changes = select([leader('0xa')], [passed('0xa', 0.7)]);

    expect(changes.get('0xa')?.after).toMatchObject({
      score: 0.7,
      scoredAt: NOW,
    });
  });

  it('pulls the average down to zero for a wallet that failed a gate', () => {
    const changes = select(
      [leader('0xa', { score: 0.6 })],
      [failed('0xa', 'short_holds')],
    );

    expect(changes.get('0xa')?.after.score).toBeCloseTo(0.42, 12);
  });

  it('leaves the average alone without a final composite', () => {
    const changes = select(
      [leader('0xa', { score: 0.6, topStreak: 0 })],
      [
        {
          walletAddress: '0xa',
          passed: true,
          composite: null,
          gateFailures: [],
        },
      ],
    );

    expect(changes.has('0xa')).toBe(false);
  });
});

describe('planSelection streaks', () => {
  const ranks = ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6'];
  const scores = ranks.map((address, index) =>
    passed(address, 0.9 - index / 10),
  );

  it.each<[string, LeaderRecord, Partial<LeaderRecord>]>([
    [
      'a candidate in the top N',
      leader('0x1', { topStreak: 1 }),
      { topStreak: 2, missStreak: 0 },
    ],
    [
      'a candidate just outside the top N',
      leader('0x3', { topStreak: 2 }),
      { topStreak: 0 },
    ],
    [
      'a shadow wallet inside the top 2.5N band',
      shadow('0x5', { missStreak: 2 }),
      { missStreak: 0 },
    ],
    [
      'a shadow wallet outside the band',
      shadow('0x6', { missStreak: 1 }),
      { missStreak: 2 },
    ],
    [
      'a shadow wallet without a final composite',
      shadow('0x9', { missStreak: 1 }),
      { missStreak: 2, topStreak: 0 },
    ],
    [
      'a manual shadow wallet outside the band',
      shadow('0x6', { source: 'MANUAL', missStreak: 0 }),
      { missStreak: 0 },
    ],
  ])('counts %s', (_, before, expected) => {
    const others = ranks
      .filter((address) => address !== before.address)
      .map((address) => leader(address, { score: null }));
    const scoresWithAverages = select(
      [before, ...others],
      scores,
      {},
      { trackedTarget: 2, streakRuns: 3 },
    );

    expect(scoresWithAverages.get(before.address)?.after).toMatchObject(
      expected,
    );
  });

  it('ranks by the smoothed score, not by the run composite', () => {
    const changes = select(
      [
        leader('0xsteady', { score: 0.9, topStreak: 2 }),
        leader('0xspike', { score: 0.1, topStreak: 2 }),
        leader('0xthird', { score: 0.5, topStreak: 2 }),
      ],
      [
        passed('0xsteady', 0.6),
        passed('0xspike', 0.99),
        passed('0xthird', 0.5),
      ],
      {},
      { trackedTarget: 1 },
    );

    expect(changes.get('0xsteady')?.after.topStreak).toBe(3);
    expect(changes.get('0xspike')?.after.topStreak).toBe(0);
  });
});

describe('planSelection admissions', () => {
  it('admits a candidate after the streak when a slot is free and clears its tracking time', () => {
    const changes = select(
      [
        leader('0xa', { score: 0.8, topStreak: 2, trackedSince: daysAgo(90) }),
        shadow('0xb', { score: 0.7 }),
      ],
      [passed('0xa', 0.8), passed('0xb', 0.7)],
    );

    expect(changes.get('0xa')?.after).toMatchObject({
      status: 'SHADOW',
      topStreak: 3,
      statusReason: 'entered_top_n',
      trackedSince: null,
    });
    expect(changes.get('0xa')?.transition).toEqual({
      address: '0xa',
      from: 'CANDIDATE',
      to: 'SHADOW',
      isPaused: false,
      reason: 'entered_top_n',
    });
  });

  it('keeps a qualified candidate waiting while the tracked set is full', () => {
    const changes = select(
      [
        leader('0xa', { score: 0.95, topStreak: 5 }),
        shadow('0xb', { score: 0.7 }),
        shadow('0xc', { score: 0.6, source: 'MANUAL' }),
      ],
      [passed('0xa', 0.95), passed('0xb', 0.7), passed('0xc', 0.6)],
    );

    expect(changes.get('0xa')?.after).toMatchObject({
      status: 'CANDIDATE',
      topStreak: 6,
    });
  });

  it('waits for the streak before admitting', () => {
    const changes = select(
      [leader('0xa', { topStreak: 1 })],
      [passed('0xa', 0.9)],
    );

    expect(changes.get('0xa')?.after.status).toBe('CANDIDATE');
  });

  it('fills a single free slot with the best smoothed score', () => {
    const changes = select(
      [
        shadow('0xheld', { score: 0.5 }),
        leader('0xa', { score: 0.7, topStreak: 0 }),
        leader('0xb', { score: 0.8, topStreak: 0 }),
      ],
      [passed('0xheld', 0.5), passed('0xa', 0.7), passed('0xb', 0.8)],
      {},
      { trackedTarget: 2, streakRuns: 1 },
    );

    expect(changes.get('0xb')?.after.status).toBe('SHADOW');
    expect(changes.get('0xa')?.after.status).toBe('CANDIDATE');
  });

  it('frees the slot of a wallet retired in the same run', () => {
    const changes = select(
      [
        shadow('0xgone', { score: 0.4 }),
        shadow('0xb', { score: 0.7 }),
        leader('0xa', { score: 0.9, topStreak: 2 }),
      ],
      [
        failed('0xgone', 'recent_liquidation'),
        passed('0xb', 0.7),
        passed('0xa', 0.9),
      ],
    );

    expect(changes.get('0xgone')?.after.status).toBe('RETIRED');
    expect(changes.get('0xa')?.after.status).toBe('SHADOW');
  });
});

describe('planSelection retirement', () => {
  it.each(['recent_liquidation', 'sub_account_master', 'off_main_dex'])(
    'retires a shadow wallet at once on the danger gate %s',
    (gate) => {
      const changes = select(
        [shadow('0xa', { source: 'MANUAL' })],
        [failed('0xa', 'short_holds', gate)],
      );

      expect(changes.get('0xa')?.after).toMatchObject({
        status: 'RETIRED',
        isPaused: false,
        statusReason: gate,
        retiredAt: NOW,
      });
      expect(changes.get('0xa')?.transition).toMatchObject({
        from: 'SHADOW',
        to: 'RETIRED',
        reason: gate,
      });
    },
  );

  it('pauses instead of retiring while the wallet still has open copies', () => {
    const changes = select(
      [shadow('0xa')],
      [failed('0xa', 'recent_liquidation')],
      { '0xa': evidence({ hasOpenCopies: true }) },
    );

    expect(changes.get('0xa')?.after).toMatchObject({
      status: 'SHADOW',
      isPaused: true,
      statusReason: 'recent_liquidation',
    });
    expect(isRetiring(changes.get('0xa')!.after)).toBe(true);
  });

  it('does not retire a shadow wallet for a gate that is not a danger', () => {
    const changes = select([shadow('0xa')], [failed('0xa', 'short_holds')]);

    expect(changes.get('0xa')?.after.status).toBe('SHADOW');
    expect(changes.get('0xa')?.transition).toBeNull();
  });

  it('retires a shadow wallet after the streak of runs outside the band', () => {
    const changes = select([shadow('0xa', { missStreak: 2 })], []);

    expect(changes.get('0xa')?.after).toMatchObject({
      status: 'RETIRED',
      statusReason: 'outside_top_band',
    });
  });

  it('keeps a manual wallet through misses and silence', () => {
    const changes = select(
      [
        shadow('0xa', {
          source: 'MANUAL',
          missStreak: 5,
          trackedSince: daysAgo(40),
        }),
      ],
      [],
      { '0xa': evidence({ lastFillAt: daysAgo(30) }) },
    );

    expect(changes.get('0xa')?.after.status ?? 'SHADOW').toBe('SHADOW');
  });

  it.each<[string, Date, Date | null, boolean]>([
    ['no fill for 15 days', daysAgo(30), daysAgo(15), true],
    ['no fill since tracking began 14 days ago', daysAgo(14), null, true],
    ['a fill 3 days ago', daysAgo(30), daysAgo(3), false],
    [
      'an old fill but tracking began 10 days ago',
      daysAgo(10),
      daysAgo(40),
      false,
    ],
  ])(
    'retires a silent shadow wallet only after 14 days: %s',
    (_, trackedSince, lastFillAt, retires) => {
      const changes = select(
        [shadow('0xa', { trackedSince })],
        [passed('0xa', 0.9)],
        { '0xa': evidence({ lastFillAt }) },
      );

      expect(changes.get('0xa')?.after.status).toBe(
        retires ? 'RETIRED' : 'SHADOW',
      );
    },
  );

  it.each<
    [string, RunScore[], Partial<LeaderEvidence['live'] & object>, string]
  >([
    ['any failed gate', [failed('0xa', 'inactive')], {}, 'inactive'],
    [
      'copy equity under 80% of the allocation',
      [passed('0xa', 0.8)],
      { returnOnAllocation: -0.21 },
      'copy_equity_floor',
    ],
    [
      'three negative weeks',
      [passed('0xa', 0.8)],
      { negativeWeeks: 3 },
      'negative_weeks',
    ],
  ])('retires a live wallet on %s', (_, scores, live, reason) => {
    const changes = select(
      [leader('0xa', { status: 'LIVE', score: 0.8, liveSince: daysAgo(30) })],
      scores,
      {
        '0xa': evidence({
          live: {
            closedCopies: 20,
            netPnlUsd: 0,
            returnOnAllocation: 0,
            maxDrawdown: 0,
            negativeWeeks: 0,
            ...live,
          },
        }),
      },
    );

    expect(changes.get('0xa')?.after).toMatchObject({
      status: 'RETIRED',
      statusReason: reason,
    });
  });

  it('finishes a pending retirement once the copies are flat', () => {
    const changes = select(
      [shadow('0xa', { isPaused: true, statusReason: 'recent_liquidation' })],
      [],
    );

    expect(changes.get('0xa')?.transition).toMatchObject({
      from: 'SHADOW',
      to: 'RETIRED',
      reason: 'recent_liquidation',
    });
  });

  it('never retires a wallet the operator paused by hand', () => {
    const changes = select(
      [
        shadow('0xa', {
          source: 'MANUAL',
          isPaused: true,
          statusReason: 'manual_pause',
        }),
      ],
      [passed('0xa', 0.6)],
    );

    expect(changes.get('0xa')?.after).toMatchObject({
      status: 'SHADOW',
      isPaused: true,
    });
  });

  it('returns a retired wallet to the candidates after 30 days', () => {
    const changes = select(
      [
        leader('0xa', { status: 'RETIRED', retiredAt: daysAgo(30) }),
        leader('0xb', { status: 'RETIRED', retiredAt: daysAgo(29) }),
      ],
      [],
    );

    expect(changes.get('0xa')?.after).toMatchObject({
      status: 'CANDIDATE',
      statusReason: 'cooldown_finished',
    });
    expect(changes.has('0xb')).toBe(false);
  });
});

describe('planSelection promotion', () => {
  const tracked = shadow('0xa', { score: 0.8, trackedSince: daysAgo(20) });

  it('promotes a ready shadow wallet in paper mode', () => {
    const changes = select([tracked], [passed('0xa', 0.8)], {
      '0xa': readyShadow(),
    });

    expect(changes.get('0xa')?.after).toMatchObject({
      status: 'LIVE',
      liveSince: NOW,
      statusReason: 'promoted',
    });
  });

  it('stops at the live limit and promotes the best scores first', () => {
    const changes = select(
      [tracked, shadow('0xb', { score: 0.9, trackedSince: daysAgo(20) })],
      [passed('0xa', 0.8), passed('0xb', 0.9)],
      { '0xa': readyShadow(), '0xb': readyShadow() },
    );

    expect(changes.get('0xb')?.after.status).toBe('LIVE');
    expect(changes.get('0xa')?.after.status).toBe('SHADOW');
  });

  it('only marks the wallet ready in live mode, so a person must promote it', () => {
    const changes = select(
      [tracked],
      [passed('0xa', 0.8)],
      { '0xa': readyShadow() },
      { promotionMode: 'manual' },
    );

    expect(changes.get('0xa')?.after).toMatchObject({
      status: 'SHADOW',
      statusReason: 'promotion_ready',
    });
    expect(changes.get('0xa')?.transition?.reason).toBe('promotion_ready');
  });

  it('does not promote a paused wallet', () => {
    const changes = select(
      [{ ...tracked, isPaused: true, statusReason: 'manual_pause' }],
      [passed('0xa', 0.8)],
      { '0xa': readyShadow() },
    );

    expect(changes.get('0xa')?.after.status).toBe('SHADOW');
  });
});

describe('listPromotionGaps', () => {
  const tracked = shadow('0xa', { trackedSince: daysAgo(20) });
  const ready = readyShadow().shadow!;

  it('finds nothing missing for a ready wallet', () => {
    expect(listPromotionGaps(tracked, readyShadow(), NOW)).toEqual([]);
  });

  it.each<[string, Partial<LeaderRecord>, Partial<typeof ready>, string]>([
    [
      '13 days of shadow',
      { trackedSince: daysAgo(13) },
      {},
      'shadow_too_short',
    ],
    ['no tracking time', { trackedSince: null }, {}, 'shadow_too_short'],
    ['9 closed copies', {}, { closedCopies: 9 }, 'too_few_closed_copies'],
    ['a flat result', {}, { netPnlUsd: 0 }, 'shadow_return_not_positive'],
    ['a 10% drawdown', {}, { maxDrawdown: -0.1 }, 'shadow_drawdown_too_deep'],
    [
      'half the entries rejected',
      {},
      { rejectionShare: 0.5 },
      'too_many_rejected_entries',
    ],
    [
      'no counted entries',
      {},
      { rejectionShare: null },
      'too_many_rejected_entries',
    ],
  ])('reports %s', (_, leaderOverrides, shadowOverrides, gap) => {
    expect(
      listPromotionGaps(
        { ...tracked, ...leaderOverrides },
        evidence({ shadow: { ...ready, ...shadowOverrides } }),
        NOW,
      ),
    ).toEqual([gap]);
  });
});
