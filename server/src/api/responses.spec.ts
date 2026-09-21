import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  type Cluster,
  type CopyPosition,
  Prisma,
} from '../generated/prisma/client';
import {
  toBookEquityPointResponse,
  toBookSummaryResponse,
  toClusterResponse,
  toCopyPositionResponse,
  toLiveEvent,
} from './responses';

const OPENED_AT = new Date('2026-04-20T08:00:00.000Z');

function copyPosition(overrides: Partial<CopyPosition> = {}): CopyPosition {
  return {
    id: 9007199254740993n,
    book: 'MAIN',
    walletAddress: '0xabc',
    coin: 'ETH',
    size: new Prisma.Decimal('-0.5000000000'),
    entryPx: new Prisma.Decimal('3000.0000000000'),
    ratio: new Prisma.Decimal('0.012500000000000000'),
    leaderSizeAtSync: new Prisma.Decimal('-40'),
    allocationUsd: new Prisma.Decimal('5000.00'),
    stopPx: null,
    isOpen: true,
    openedAt: OPENED_AT,
    lastOrderAt: OPENED_AT,
    closedAt: null,
    closeReason: null,
    realizedPnl: new Prisma.Decimal('0'),
    feesUsd: new Prisma.Decimal('0.675000'),
    fundingUsd: new Prisma.Decimal('-0.0000001'),
    leaderOpenTid: 123n,
    ...overrides,
  };
}

describe('toCopyPositionResponse', () => {
  it('turns ids and decimals into plain strings and marks an open short', () => {
    const response = toCopyPositionResponse(
      copyPosition(),
      new Decimal('2950.5'),
    );

    expect(response).toMatchObject({
      id: '9007199254740993',
      size: '-0.5',
      entryPx: '3000',
      ratio: '0.0125',
      markPx: '2950.5',
      unrealizedPnl: '24.75',
      fundingUsd: '-0.0000001',
      leaderOpenTid: '123',
      openedAt: '2026-04-20T08:00:00.000Z',
    });
  });

  it('shows no mark on a closed copy', () => {
    const response = toCopyPositionResponse(
      copyPosition({ isOpen: false, closedAt: OPENED_AT }),
      new Decimal('2950.5'),
    );

    expect(response.markPx).toBe(null);
    expect(response.unrealizedPnl).toBe(null);
  });
});

describe('toBookSummaryResponse', () => {
  const summary = {
    unrealizedPnl: new Decimal('-12'),
    realizedPnlToday: new Decimal('-175.655'),
    grossExposureUsd: new Decimal('9000'),
    openPositions: 3,
  };

  it('measures the day PnL against the day start of the main book only', () => {
    expect(
      toBookSummaryResponse({
        ...summary,
        book: 'MAIN',
        valueKind: 'equity',
        valueUsd: new Decimal('24812.345'),
        dayStartEquity: new Decimal('25000'),
      }),
    ).toMatchObject({
      valueKind: 'equity',
      valueUsd: '24812.35',
      dayPnl: '-187.66',
      dayStartEquity: '25000.00',
    });
  });

  it('passes the shadow book on as net PnL without a day PnL', () => {
    expect(
      toBookSummaryResponse({
        ...summary,
        book: 'SHADOW',
        valueKind: 'net_pnl',
        valueUsd: new Decimal('-31.004'),
        dayStartEquity: null,
      }),
    ).toMatchObject({ valueKind: 'net_pnl', valueUsd: '-31.00', dayPnl: null });
  });
});

describe('toBookEquityPointResponse', () => {
  it('labels main snapshots as equity and shadow snapshots as net PnL', () => {
    const snapshot = {
      takenAt: new Date('2026-04-20T12:05:00.000Z'),
      equityUsd: new Prisma.Decimal('12.6'),
      unrealizedPnl: new Prisma.Decimal('10'),
      realizedPnlToday: new Prisma.Decimal('0'),
      grossExposureUsd: new Prisma.Decimal('450'),
      openPositions: 1,
    };
    expect(
      toBookEquityPointResponse({ ...snapshot, book: 'SHADOW' }),
    ).toMatchObject({ valueKind: 'net_pnl', valueUsd: '12.6' });
    expect(
      toBookEquityPointResponse({ ...snapshot, book: 'MAIN' }).valueKind,
    ).toBe('equity');
  });
});

describe('toClusterResponse', () => {
  it('joins each assigned wallet with what the collector last reported', () => {
    const cluster: Cluster & {
      wallets: { address: string; status: 'SHADOW' | 'LIVE' }[];
    } = {
      id: 1,
      isOnline: true,
      sessionId: 'session-1',
      version: '1.4.0',
      maxWallets: 8,
      assignVersion: 3,
      connectedAt: OPENED_AT,
      lastHeartbeatAt: OPENED_AT,
      lastStats: {
        upstreamState: 'open',
        upstreamConnectedAt: 1_776_672_000_000,
        upstreamReconnects: 0,
        pingRoundTripMs: 41,
        clockOffsetMs: 3,
        eventLoopDelayP99Ms: 12,
        rssBytes: 90_000_000,
        weightUsedLastMinute: 40,
        wallets: [
          {
            address: '0xaaa',
            subscribedAt: 1_776_672_000_000,
            lastEventAt: 1_776_672_005_000,
            backfill: 'synced',
          },
        ],
      },
      wallets: [
        { address: '0xaaa', status: 'LIVE' },
        { address: '0xbbb', status: 'SHADOW' },
      ],
    };

    expect(toClusterResponse(cluster).wallets).toEqual([
      {
        address: '0xaaa',
        status: 'LIVE',
        subscribedAt: '2026-04-20T08:00:00.000Z',
        lastEventAt: '2026-04-20T08:00:05.000Z',
        backfill: 'synced',
      },
      {
        address: '0xbbb',
        status: 'SHADOW',
        subscribedAt: null,
        lastEventAt: null,
        backfill: null,
      },
    ]);
  });
});

describe('toLiveEvent', () => {
  it('turns bigint ids and dates into strings', () => {
    expect(
      toLiveEvent({
        type: 'decision',
        book: 'SHADOW',
        decisionId: 42n,
        wallet: '0xabc',
        coin: 'BTC',
        action: 'OPEN',
        verdict: 'SKIP',
        reason: 'stale_signal',
        decidedAt: OPENED_AT,
      }),
    ).toEqual({
      type: 'decision',
      book: 'SHADOW',
      decisionId: '42',
      wallet: '0xabc',
      coin: 'BTC',
      action: 'OPEN',
      verdict: 'SKIP',
      reason: 'stale_signal',
      decidedAt: '2026-04-20T08:00:00.000Z',
    });
    expect(
      JSON.stringify(
        toLiveEvent({
          type: 'copy',
          book: 'MAIN',
          positionId: 7n,
          wallet: '0xabc',
          coin: 'BTC',
          change: 'opened',
          size: '0.01',
          realizedPnl: '0',
        }),
      ),
    ).toContain('"positionId":"7"');
  });
});
