import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  checkCopyAgainstLeader,
  compareFills,
  type DecisionLink,
  findBrokenDecisionChains,
  findUnprovokedRefusals,
} from './invariants';

function decision(
  id: string,
  positionBefore: string,
  positionAfter: string,
  overrides: Partial<DecisionLink> = {},
): DecisionLink {
  return {
    id,
    book: 'SHADOW',
    wallet: '0xaa',
    coin: 'BTC',
    reason: 'copied',
    positionBefore,
    positionAfter,
    ...overrides,
  };
}

function copyCheck(overrides: {
  size: string;
  leaderPosition: string;
  hasRecordedShortfall?: boolean;
}) {
  return checkCopyAgainstLeader({
    size: new Decimal(overrides.size),
    ratio: new Decimal('0.01'),
    leaderPosition: new Decimal(overrides.leaderPosition),
    mid: new Decimal(100),
    szDecimals: 2,
    hasRecordedShortfall: overrides.hasRecordedShortfall ?? false,
  });
}

describe('compareFills', () => {
  it('lists simulator fills that Postgres lacks and stored fills the simulator never made', () => {
    const result = compareFills(
      [
        { coin: 'BTC', tid: '1', time: 10 },
        { coin: 'BTC', tid: '2', time: 11 },
      ],
      [
        { coin: 'BTC', tid: '2', time: 11 },
        { coin: 'ETH', tid: '1', time: 10 },
      ],
    );

    expect(result.missing).toEqual([{ coin: 'BTC', tid: '1', time: 10 }]);
    expect(result.unknown).toEqual([{ coin: 'ETH', tid: '1', time: 10 }]);
  });
});

describe('findBrokenDecisionChains', () => {
  it('accepts decisions that each start where the previous one ended', () => {
    expect(
      findBrokenDecisionChains([
        decision('1', '0', '1.5'),
        decision('2', '1.50', '0.5'),
        decision('3', '0.5', '0'),
        decision('4', '0', '-2'),
      ]),
    ).toEqual([]);
  });

  it('reports a decision that repeats fills already decided', () => {
    const breaks = findBrokenDecisionChains([
      decision('1', '0', '1'),
      decision('2', '1', '2'),
      decision('3', '1', '2'),
    ]);

    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toContain('decision 3 starts at 1');
  });

  it('keeps chains apart per book, wallet and coin', () => {
    expect(
      findBrokenDecisionChains([
        decision('1', '0', '1'),
        decision('2', '0', '3', { coin: 'ETH' }),
        decision('3', '0', '1', { book: 'MAIN' }),
        decision('4', '1', '0'),
      ]),
    ).toEqual([]);
  });

  it('leaves out_of_order records out of the chain', () => {
    expect(
      findBrokenDecisionChains([
        decision('1', '0', '1'),
        decision('2', '5', '6', { reason: 'out_of_order' }),
        decision('3', '1', '0'),
      ]),
    ).toEqual([]);
  });
});

describe('checkCopyAgainstLeader', () => {
  it('matches a copy at k times the leader', () => {
    expect(copyCheck({ size: '1.5', leaderPosition: '150' }).outcome).toBe(
      'matches',
    );
  });

  it('accepts a difference within one lot and the minimum order', () => {
    expect(copyCheck({ size: '1.6', leaderPosition: '150' }).outcome).toBe(
      'matches',
    );
    expect(copyCheck({ size: '-1.4', leaderPosition: '-150' }).outcome).toBe(
      'matches',
    );
  });

  it('reports a copy that holds more than k times the leader', () => {
    const check = copyCheck({ size: '3', leaderPosition: '150' });

    expect(check.outcome).toBe('violation');
    expect(check.detail).toContain('holds more than its leader');
  });

  it('reports a copy on the other side of the leader', () => {
    expect(copyCheck({ size: '-1.5', leaderPosition: '150' }).detail).toContain(
      'wrong side',
    );
  });

  it('reports an open copy whose leader is flat', () => {
    expect(copyCheck({ size: '1.5', leaderPosition: '0' }).detail).toContain(
      'leader is flat',
    );
  });

  it('accepts a smaller copy only when its decisions or orders record why', () => {
    expect(copyCheck({ size: '0.5', leaderPosition: '150' }).outcome).toBe(
      'violation',
    );
    expect(
      copyCheck({
        size: '0.5',
        leaderPosition: '150',
        hasRecordedShortfall: true,
      }).outcome,
    ).toBe('explained_shortfall');
    expect(
      copyCheck({
        size: '0',
        leaderPosition: '150',
        hasRecordedShortfall: true,
      }).outcome,
    ).toBe('explained_shortfall');
  });
});

describe('findUnprovokedRefusals', () => {
  it('keeps only refusals of limits the scenario did not provoke', () => {
    const refusals = [
      { at: 1, ip: '10.0.0.2', limit: 'users', detail: 'Cannot track more' },
      { at: 2, ip: '10.0.0.3', limit: 'new_connections', detail: '429' },
    ];

    expect(findUnprovokedRefusals(refusals, ['users'])).toEqual([refusals[1]]);
    expect(findUnprovokedRefusals(refusals, [])).toEqual(refusals);
  });
});
