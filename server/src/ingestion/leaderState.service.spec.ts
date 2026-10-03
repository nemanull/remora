import type {
  HyperliquidClearinghouseStateData,
  PortfolioResponse,
} from '@remora/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import {
  LeaderStateService,
  readLatestEquity,
  readLeaderPositions,
} from './leaderState.service';

const WALLET = '0x6fa50b6e7be0e4df463b343114424ebb3108fd1d';

function period(points: [number, string][]) {
  return {
    accountValueHistory: points,
    pnlHistory: points.map(([time]) => [time, '0'] as [number, string]),
    vlm: '0',
  };
}

const PORTFOLIO: PortfolioResponse = [
  [
    'day',
    period([
      [1_790_800_800_016, '26884115.15'],
      [1_790_887_346_672, '25666875.58'],
    ]),
  ],
  [
    'week',
    period([
      [1_790_281_200_035, '28955115.57'],
      [1_790_887_346_672, '25666875.58'],
    ]),
  ],
  [
    'allTime',
    period([
      [1_775_688_000_026, '0.0'],
      [1_790_887_346_600, '25660000.00'],
    ]),
  ],
  ['perpDay', period([[1_790_887_346_999, '2282446.08']])],
];

function clearinghouseState(
  time: number,
  dex = '',
): HyperliquidClearinghouseStateData {
  return {
    dex,
    user: WALLET,
    clearinghouseState: {
      marginSummary: {
        accountValue: '118429.26',
        totalNtlPos: '921834.00',
        totalRawUsd: '-803404.74',
        totalMarginUsed: '118429.26',
      },
      crossMarginSummary: {
        accountValue: '0.0',
        totalNtlPos: '0.0',
        totalRawUsd: '0.0',
        totalMarginUsed: '0.0',
      },
      crossMaintenanceMarginUsed: '0.0',
      withdrawable: '0.0',
      assetPositions: [
        {
          type: 'oneWay',
          position: {
            coin: 'NEAR',
            szi: '189865.3',
            leverage: { type: 'isolated', value: 8, rawUsd: '-803404.74' },
            entryPx: '4.832',
            positionValue: '921834.00456',
            unrealizedPnl: '4404.87496',
            returnOnEquity: '0.038410596',
            liquidationPx: '4.4541535566',
            marginUsed: '118429.263361',
            maxLeverage: 10,
            cumFunding: {
              allTime: '1.815492',
              sinceOpen: '0.0',
              sinceChange: '0.0',
            },
          },
        },
      ],
      time,
    },
  };
}

function createService(updatedCount: number) {
  const updateMany = vi.fn().mockResolvedValue({ count: updatedCount });
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    leaderState: { updateMany, createMany },
  } as unknown as PrismaService;
  return { service: new LeaderStateService(prisma), updateMany, createMany };
}

describe('readLatestEquity', () => {
  it('takes the latest point of the combined account value history', () => {
    expect(readLatestEquity(PORTFOLIO)).toEqual({
      value: '25666875.58',
      time: new Date(1_790_887_346_672),
    });
  });

  it('returns nothing for a portfolio without combined points', () => {
    expect(readLatestEquity([['perpDay', period([[1, '5']])]])).toBeNull();
  });
});

describe('readLeaderPositions', () => {
  it('maps asset positions to signed sizes with domain names', () => {
    expect(readLeaderPositions(clearinghouseState(1_790_888_044_286))).toEqual([
      {
        coin: 'NEAR',
        size: '189865.3',
        entryPrice: '4.832',
        positionValue: '921834.00456',
        unrealizedPnl: '4404.87496',
        leverageType: 'isolated',
        leverage: 8,
        liquidationPrice: '4.4541535566',
        marginUsed: '118429.263361',
      },
    ]);
  });
});

describe('LeaderStateService', () => {
  it('replaces positions only with a newer exchange time', async () => {
    const { service, updateMany, createMany } = createService(1);
    const state = clearinghouseState(1_790_888_044_286);

    await service.applyClearinghouseState(WALLET, state);

    const positionsAt = new Date(1_790_888_044_286);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        walletAddress: WALLET,
        OR: [{ positionsAt: null }, { positionsAt: { lt: positionsAt } }],
      },
      data: { positions: readLeaderPositions(state), positionsAt },
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('creates the leader state when no row was updated', async () => {
    const { service, createMany } = createService(0);

    await service.applyPortfolio(WALLET, PORTFOLIO);

    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          walletAddress: WALLET,
          equityUsd: '25666875.58',
          equityAt: new Date(1_790_887_346_672),
        },
      ],
      skipDuplicates: true,
    });
  });

  it('ignores the state of a HIP-3 dex', async () => {
    const { service, updateMany } = createService(1);

    await service.applyClearinghouseState(
      WALLET,
      clearinghouseState(1_790_888_044_286, 'xyz'),
    );

    expect(updateMany).not.toHaveBeenCalled();
  });
});
