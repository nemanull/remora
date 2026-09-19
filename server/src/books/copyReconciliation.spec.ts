import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { CopyView } from '../copy/types';
import { reconcileCopy } from './copyReconciliation';

const NOW = new Date('2026-04-20T12:00:00.000Z');

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}

function copy(overrides: Partial<CopyView> = {}): CopyView {
  return {
    id: 7n,
    wallet: '0x1111111111111111111111111111111111111111',
    coin: 'BTC',
    size: new Decimal('0.01'),
    ratio: new Decimal('0.005'),
    leaderSizeAtSync: new Decimal(2),
    allocationUsd: new Decimal(5_000),
    notionalUsd: new Decimal(650),
    openedAt: ago(600_000),
    lastOrderAt: ago(120_000),
    ...overrides,
  };
}

function reconcile(
  held: CopyView,
  leaderPosition: string | null,
  stateAgeMs: number | null,
) {
  return reconcileCopy({
    copy: held,
    leaderPosition:
      leaderPosition === null ? null : new Decimal(leaderPosition),
    leaderPositionsAt: stateAgeMs === null ? null : ago(stateAgeMs),
    mid: new Decimal(65_000),
    szDecimals: 5,
    now: NOW,
  });
}

describe('reconcileCopy', () => {
  it('closes a copy whose leader is flat on fresh state', () => {
    expect(reconcile(copy(), '0', 10_000)).toMatchObject({
      outcome: 'close',
      reason: 'leader_flat',
    });
  });

  it('closes a copy whose leader is on the other side', () => {
    expect(reconcile(copy(), '-1', 10_000)).toMatchObject({
      outcome: 'close',
      reason: 'leader_flipped',
    });
  });

  it('closes a copy without size the same way', () => {
    expect(
      reconcile(copy({ size: new Decimal(0), lastOrderAt: null }), '0', 10_000),
    ).toMatchObject({ outcome: 'close', reason: 'leader_flat' });
  });

  it('does not close a fresh copy on a state taken before it opened', () => {
    const fresh = copy({ openedAt: ago(4_000), lastOrderAt: ago(3_000) });

    expect(reconcile(fresh, '0', 5_000)).toMatchObject({
      outcome: 'hold',
      reason: 'leader_state_predates_copy',
    });
  });

  it('needs the state to be more than 5 s newer than the last order', () => {
    const recent = copy({ lastOrderAt: ago(15_000) });

    expect(reconcile(recent, '0', 10_000)).toMatchObject({
      outcome: 'hold',
      reason: 'leader_state_predates_copy',
    });
    expect(reconcile(recent, '0', 9_999)).toMatchObject({
      outcome: 'close',
      reason: 'leader_flat',
    });
  });

  it('measures a copy without orders from its opening', () => {
    const unfilled = copy({
      size: new Decimal(0),
      openedAt: ago(8_000),
      lastOrderAt: null,
    });

    expect(reconcile(unfilled, '0', 4_000)).toMatchObject({
      reason: 'leader_state_predates_copy',
    });
  });

  it('does not trade on a state 30 s old or older', () => {
    expect(reconcile(copy(), '0', 30_000)).toMatchObject({
      outcome: 'hold',
      reason: 'leader_state_stale',
    });
    expect(reconcile(copy(), '0', 29_999)).toMatchObject({
      outcome: 'close',
    });
  });

  it('holds when no leader state is stored', () => {
    expect(reconcile(copy(), null, null)).toMatchObject({
      outcome: 'hold',
      reason: 'leader_state_missing',
    });
  });

  it('holds a copy whose leader is at the synced size', () => {
    expect(reconcile(copy(), '2', 10_000)).toMatchObject({
      outcome: 'hold',
      reason: 'in_sync',
    });
  });

  it('ignores drift that the fast path would also defer', () => {
    expect(reconcile(copy(), '1.99', 10_000)).toMatchObject({
      outcome: 'hold',
      reason: 'drift_below_minimum',
    });
  });

  it('reports drift worth an order without trading on it', () => {
    const result = reconcile(copy(), '3', 10_000);

    expect(result.outcome).toBe('drift');
    if (result.outcome !== 'drift') {
      return;
    }
    expect(result.expectedSize.toFixed()).toBe('0.015');
    expect(result.driftSize.toFixed()).toBe('0.005');
    expect(result.driftUsd.toFixed()).toBe('325');
  });

  it('measures a missed reduce by the leader fraction', () => {
    const result = reconcile(copy(), '1', 10_000);

    expect(result.outcome).toBe('drift');
    if (result.outcome !== 'drift') {
      return;
    }
    expect(result.expectedSize.toFixed()).toBe('0.005');
    expect(result.driftSize.toFixed()).toBe('-0.005');
  });
});
