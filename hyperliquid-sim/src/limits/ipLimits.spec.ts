import { describe, expect, it } from 'vitest';
import { IpLimits, normalizeSourceAddress } from './ipLimits';

const NOW = 1_780_000_000_000;
const COLLECTOR_A = '10.0.0.11';
const COLLECTOR_B = '10.0.0.12';

function createLimits(): IpLimits {
  return new IpLimits({
    maxConnections: 3,
    newConnectionsPerMinute: 5,
    maxUsers: 2,
    maxSubscriptions: 4,
    messagesPerMinute: 6,
    weightPerMinute: 100,
  });
}

function user(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

describe('IpLimits', () => {
  it('refuses a connection past the open connection limit until one closes', () => {
    const limits = createLimits();
    expect(
      [1, 2, 3].map(() => limits.admitConnection(COLLECTOR_A, NOW)),
    ).toEqual([true, true, true]);
    expect(limits.admitConnection(COLLECTOR_A, NOW)).toBe(false);
    expect(limits.admitConnection(COLLECTOR_B, NOW)).toBe(true);
    limits.releaseConnection(COLLECTOR_A);
    expect(limits.admitConnection(COLLECTOR_A, NOW + 1)).toBe(true);
    expect(limits.readRefusals()).toEqual([
      {
        at: NOW,
        ip: COLLECTOR_A,
        limit: 'connections',
        detail: '3 connections are open',
      },
    ]);
  });

  it('refuses new connections past the per-minute rate and admits them a minute later', () => {
    const limits = createLimits();
    for (let index = 0; index < 5; index += 1) {
      expect(limits.admitConnection(COLLECTOR_A, NOW + index)).toBe(true);
      limits.releaseConnection(COLLECTOR_A);
    }
    expect(limits.admitConnection(COLLECTOR_A, NOW + 10)).toBe(false);
    expect(limits.admitConnection(COLLECTOR_A, NOW + 60_001)).toBe(true);
    expect(limits.readRefusalCounts().new_connections).toBe(1);
    expect(limits.summarizeUsage(NOW + 60_001)).toEqual([
      {
        ip: COLLECTOR_A,
        connections: 1,
        connectionsOpened: 6,
        newConnectionsLastMinute: 4,
        users: 0,
        subscriptions: 0,
        messagesLastMinute: 0,
        weightLastMinute: 0,
      },
    ]);
  });

  it('counts unique users once across their channels and refuses one more', () => {
    const limits = createLimits();
    expect(limits.admitSubscription(COLLECTOR_A, user(1), NOW)).toBeNull();
    expect(limits.admitSubscription(COLLECTOR_A, user(1), NOW)).toBeNull();
    expect(limits.admitSubscription(COLLECTOR_A, user(2), NOW)).toBeNull();
    expect(limits.admitSubscription(COLLECTOR_A, user(3), NOW)).toBe('users');
    expect(limits.admitSubscription(COLLECTOR_B, user(3), NOW)).toBeNull();
    expect(
      limits.summarizeUsage(NOW).find((usage) => usage.ip === COLLECTOR_A),
    ).toMatchObject({ users: 2, subscriptions: 3 });
  });

  it('frees a user only when its last subscription is released', () => {
    const limits = createLimits();
    limits.admitSubscription(COLLECTOR_A, user(1), NOW);
    limits.admitSubscription(COLLECTOR_A, user(1), NOW);
    limits.admitSubscription(COLLECTOR_A, user(2), NOW);
    limits.releaseSubscription(COLLECTOR_A, user(1));
    expect(limits.admitSubscription(COLLECTOR_A, user(3), NOW)).toBe('users');
    limits.releaseSubscription(COLLECTOR_A, user(1));
    expect(limits.admitSubscription(COLLECTOR_A, user(3), NOW)).toBeNull();
  });

  it('refuses subscriptions past the subscription limit, including market channels', () => {
    const limits = createLimits();
    limits.admitSubscription(COLLECTOR_A, user(1), NOW);
    limits.admitSubscription(COLLECTOR_A, null, NOW);
    limits.admitSubscription(COLLECTOR_A, user(1), NOW);
    limits.admitSubscription(COLLECTOR_A, null, NOW);
    expect(limits.admitSubscription(COLLECTOR_A, null, NOW)).toBe(
      'subscriptions',
    );
    expect(limits.readRefusalCounts().subscriptions).toBe(1);
  });

  it('refuses messages past the per-minute rate within a sliding minute', () => {
    const limits = createLimits();
    for (let index = 0; index < 6; index += 1) {
      expect(limits.admitMessage(COLLECTOR_A, NOW + index * 1_000)).toBe(true);
    }
    expect(limits.admitMessage(COLLECTOR_A, NOW + 30_000)).toBe(false);
    expect(limits.admitMessage(COLLECTOR_A, NOW + 60_001)).toBe(true);
    expect(limits.readRefusalCounts().messages).toBe(1);
  });

  it('refuses REST weight past the per-minute budget, counting surcharges', () => {
    const limits = createLimits();
    expect(limits.admitWeight(COLLECTOR_A, 20, NOW)).toBe(true);
    limits.chargeWeight(COLLECTOR_A, 60, NOW);
    expect(limits.admitWeight(COLLECTOR_A, 20, NOW + 1)).toBe(true);
    expect(limits.admitWeight(COLLECTOR_A, 2, NOW + 2)).toBe(false);
    expect(limits.admitWeight(COLLECTOR_B, 20, NOW + 2)).toBe(true);
    expect(limits.admitWeight(COLLECTOR_A, 20, NOW + 60_001)).toBe(true);
    expect(limits.readRefusals(NOW + 2)).toEqual([
      {
        at: NOW + 2,
        ip: COLLECTOR_A,
        limit: 'rest_weight',
        detail: '100 weight used in the last minute, 2 requested',
      },
    ]);
  });

  it('treats IPv4-mapped IPv6 sources as the same address', () => {
    expect(normalizeSourceAddress('::ffff:10.0.0.11')).toBe(COLLECTOR_A);
    expect(normalizeSourceAddress(COLLECTOR_A)).toBe(COLLECTOR_A);
    expect(normalizeSourceAddress(undefined)).toBe('unknown');
  });
});
