import { describe, expect, it } from 'vitest';
import {
  assignWallets,
  rankWallets,
  type AssignmentCluster,
  type AssignmentWallet,
} from './walletAssignment';

const NOW = new Date('2026-04-20T12:00:00.000Z');
const GRACE_MS = 30_000;

function wallet(
  address: string,
  overrides: Partial<AssignmentWallet> = {},
): AssignmentWallet {
  return {
    address,
    status: 'SHADOW',
    isManual: false,
    hasOpenCopy: false,
    score: 0.5,
    ...overrides,
  };
}

function cluster(
  id: number,
  capacity: number,
  overrides: Partial<AssignmentCluster> = {},
): AssignmentCluster {
  return {
    id,
    isOnline: true,
    capacity,
    offlineSince: null,
    refusedWallets: new Set(),
    ...overrides,
  };
}

function assign(
  wallets: AssignmentWallet[],
  clusters: AssignmentCluster[],
  current: Record<string, number> = {},
) {
  return assignWallets({
    wallets,
    clusters,
    current: new Map(Object.entries(current)),
    now: NOW,
    graceMs: GRACE_MS,
  });
}

describe('rankWallets', () => {
  it('ranks open copies, then LIVE, then MANUAL, then SHADOW by score', () => {
    const ranked = rankWallets([
      wallet('0xshadow-low', { score: 0.2 }),
      wallet('0xmanual', { isManual: true, score: null }),
      wallet('0xlive', { status: 'LIVE', score: 0.1 }),
      wallet('0xshadow-high', { score: 0.9 }),
      wallet('0xcopy', { hasOpenCopy: true, score: 0.05 }),
      wallet('0xshadow-unscored', { score: null }),
    ]);

    expect(ranked.map((entry) => entry.address)).toEqual([
      '0xcopy',
      '0xlive',
      '0xmanual',
      '0xshadow-high',
      '0xshadow-low',
      '0xshadow-unscored',
    ]);
  });
});

describe('assignWallets', () => {
  it('keeps every wallet on its live collector', () => {
    const result = assign(
      [wallet('0xa'), wallet('0xb'), wallet('0xc')],
      [cluster(1, 8), cluster(2, 8)],
      { '0xa': 2, '0xb': 1, '0xc': 2 },
    );

    expect(Object.fromEntries(result.assignments)).toEqual({
      '0xa': 2,
      '0xb': 1,
      '0xc': 2,
    });
    expect(result.waiting).toEqual([]);
  });

  it('sends unassigned wallets to the collector with the most free capacity', () => {
    const result = assign(
      [wallet('0xa'), wallet('0xb'), wallet('0xc'), wallet('0xd')],
      [cluster(1, 4), cluster(2, 4)],
      { '0xa': 1, '0xb': 1 },
    );

    expect(result.assignments.get('0xc')).toBe(2);
    expect(result.assignments.get('0xd')).toBe(2);
  });

  it('breaks ties in free capacity by the lowest cluster id', () => {
    const result = assign([wallet('0xa')], [cluster(3, 4), cluster(2, 4)]);

    expect(result.assignments.get('0xa')).toBe(2);
  });

  it('never fills a collector beyond its capacity and leaves the rest waiting', () => {
    const result = assign(
      [
        wallet('0xa', { score: 0.9 }),
        wallet('0xb', { score: 0.8 }),
        wallet('0xc', { score: 0.7 }),
      ],
      [cluster(1, 2)],
    );

    expect([...result.assignments.keys()]).toEqual(['0xa', '0xb']);
    expect(result.waiting).toEqual(['0xc']);
  });

  it('keeps the best ranked wallets when a collector loses capacity', () => {
    const result = assign(
      [
        wallet('0xa', { score: 0.3 }),
        wallet('0xb', { score: 0.9 }),
        wallet('0xc', { score: 0.6 }),
      ],
      [cluster(1, 2)],
      { '0xa': 1, '0xb': 1, '0xc': 1 },
    );

    expect(result.assignments.get('0xb')).toBe(1);
    expect(result.assignments.get('0xc')).toBe(1);
    expect(result.waiting).toEqual(['0xa']);
  });

  it('lets a LIVE wallet take the slot of the lowest ranked SHADOW wallet', () => {
    const result = assign(
      [
        wallet('0xshadow-high', { score: 0.9 }),
        wallet('0xshadow-low', { score: 0.1 }),
        wallet('0xlive', { status: 'LIVE' }),
      ],
      [cluster(1, 2)],
      { '0xshadow-high': 1, '0xshadow-low': 1 },
    );

    expect(result.assignments.get('0xlive')).toBe(1);
    expect(result.assignments.get('0xshadow-high')).toBe(1);
    expect(result.assignments.has('0xshadow-low')).toBe(false);
    expect(result.waiting).toEqual(['0xshadow-low']);
  });

  it('lets a wallet with an open copy preempt a SHADOW wallet', () => {
    const result = assign(
      [
        wallet('0xshadow'),
        wallet('0xretiring', { status: 'RETIRED', hasOpenCopy: true }),
      ],
      [cluster(1, 1)],
      { '0xshadow': 1 },
    );

    expect(result.assignments.get('0xretiring')).toBe(1);
    expect(result.waiting).toEqual(['0xshadow']);
  });

  it('never preempts a SHADOW wallet that holds an open copy', () => {
    const result = assign(
      [
        wallet('0xshadow-copy', { hasOpenCopy: true }),
        wallet('0xlive', { status: 'LIVE' }),
      ],
      [cluster(1, 1)],
      { '0xshadow-copy': 1 },
    );

    expect(result.assignments.get('0xshadow-copy')).toBe(1);
    expect(result.waiting).toEqual(['0xlive']);
  });

  it('never lets a SHADOW wallet preempt another SHADOW wallet', () => {
    const result = assign(
      [wallet('0xold', { score: 0.1 }), wallet('0xnew', { score: 0.9 })],
      [cluster(1, 1)],
      { '0xold': 1 },
    );

    expect(result.assignments.get('0xold')).toBe(1);
    expect(result.waiting).toEqual(['0xnew']);
  });

  it('moves a preempted wallet to free capacity on a collector that refused the preempting wallet', () => {
    const result = assign(
      [wallet('0xshadow'), wallet('0xlive', { status: 'LIVE' })],
      [cluster(1, 1), cluster(2, 1, { refusedWallets: new Set(['0xlive']) })],
      { '0xshadow': 1 },
    );

    expect(result.assignments.get('0xlive')).toBe(1);
    expect(result.assignments.get('0xshadow')).toBe(2);
    expect(result.waiting).toEqual([]);
  });

  it('keeps the wallets of a lost collector during the grace period', () => {
    const result = assign(
      [wallet('0xa'), wallet('0xb')],
      [
        cluster(1, 8, {
          isOnline: false,
          offlineSince: new Date(NOW.getTime() - GRACE_MS + 1_000),
        }),
        cluster(2, 8),
      ],
      { '0xa': 1, '0xb': 1 },
    );

    expect(result.assignments.get('0xa')).toBe(1);
    expect(result.assignments.get('0xb')).toBe(1);
  });

  it('moves the wallets of a lost collector once the grace period ends', () => {
    const result = assign(
      [wallet('0xa'), wallet('0xb')],
      [
        cluster(1, 8, {
          isOnline: false,
          offlineSince: new Date(NOW.getTime() - GRACE_MS),
        }),
        cluster(2, 8),
      ],
      { '0xa': 1, '0xb': 1 },
    );

    expect(result.assignments.get('0xa')).toBe(2);
    expect(result.assignments.get('0xb')).toBe(2);
  });

  it('never places a new wallet on a collector in its grace period', () => {
    const result = assign(
      [wallet('0xa')],
      [
        cluster(1, 8, {
          isOnline: false,
          offlineSince: new Date(NOW.getTime() - 1_000),
        }),
      ],
    );

    expect(result.assignments.size).toBe(0);
    expect(result.waiting).toEqual(['0xa']);
  });

  it('moves a wallet away from a collector that refused it', () => {
    const result = assign(
      [wallet('0xa')],
      [cluster(1, 8, { refusedWallets: new Set(['0xa']) }), cluster(2, 8)],
      { '0xa': 1 },
    );

    expect(result.assignments.get('0xa')).toBe(2);
  });

  it('leaves every wallet waiting when no collector is online', () => {
    const result = assign(
      [wallet('0xlive', { status: 'LIVE' }), wallet('0xa')],
      [],
      { '0xa': 4 },
    );

    expect(result.assignments.size).toBe(0);
    expect(result.waiting).toEqual(['0xlive', '0xa']);
  });
});
