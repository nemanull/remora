import { Injectable } from '@nestjs/common';
import type {
  HyperliquidClearinghouseStateData,
  PortfolioResponse,
  PortfolioWindow,
} from '@remora/sdk';
import { PrismaService } from '../prisma/prisma.service';

const COMBINED_WINDOWS: ReadonlySet<PortfolioWindow> = new Set([
  'day',
  'week',
  'month',
  'allTime',
]);
const MAIN_DEX = '';

export type LeaderPosition = {
  coin: string;
  size: string;
  entryPrice: string;
  positionValue: string;
  unrealizedPnl: string;
  leverageType: 'cross' | 'isolated';
  leverage: number;
  liquidationPrice: string | null;
  marginUsed: string;
};

export type EquityPoint = {
  value: string;
  time: Date;
};

export function readLeaderPositions(
  payload: HyperliquidClearinghouseStateData,
): LeaderPosition[] {
  return payload.clearinghouseState.assetPositions.map(({ position }) => ({
    coin: position.coin,
    size: position.szi,
    entryPrice: position.entryPx,
    positionValue: position.positionValue,
    unrealizedPnl: position.unrealizedPnl,
    leverageType: position.leverage.type,
    leverage: position.leverage.value,
    liquidationPrice: position.liquidationPx,
    marginUsed: position.marginUsed,
  }));
}

export function readLatestEquity(
  portfolio: PortfolioResponse,
): EquityPoint | null {
  let latest: [number, string] | null = null;
  for (const [window, period] of portfolio) {
    if (!COMBINED_WINDOWS.has(window)) {
      continue;
    }
    const point = period.accountValueHistory.at(-1);
    if (point && (latest === null || point[0] > latest[0])) {
      latest = point;
    }
  }
  return latest === null
    ? null
    : { value: latest[1], time: new Date(latest[0]) };
}

@Injectable()
export class LeaderStateService {
  constructor(private readonly prisma: PrismaService) {}

  async applyClearinghouseState(
    wallet: string,
    payload: HyperliquidClearinghouseStateData,
  ): Promise<void> {
    if (payload.dex !== MAIN_DEX) {
      return;
    }
    const positions = readLeaderPositions(payload);
    const positionsAt = new Date(payload.clearinghouseState.time);
    const updated = await this.prisma.leaderState.updateMany({
      where: {
        walletAddress: wallet,
        OR: [{ positionsAt: null }, { positionsAt: { lt: positionsAt } }],
      },
      data: { positions, positionsAt },
    });
    if (updated.count === 0) {
      await this.prisma.leaderState.createMany({
        data: [{ walletAddress: wallet, positions, positionsAt }],
        skipDuplicates: true,
      });
    }
  }

  async applyPortfolio(
    wallet: string,
    portfolio: PortfolioResponse,
  ): Promise<void> {
    const equity = readLatestEquity(portfolio);
    if (equity === null) {
      return;
    }
    const updated = await this.prisma.leaderState.updateMany({
      where: {
        walletAddress: wallet,
        OR: [{ equityAt: null }, { equityAt: { lt: equity.time } }],
      },
      data: { equityUsd: equity.value, equityAt: equity.time },
    });
    if (updated.count === 0) {
      await this.prisma.leaderState.createMany({
        data: [
          {
            walletAddress: wallet,
            equityUsd: equity.value,
            equityAt: equity.time,
          },
        ],
        skipDuplicates: true,
      });
    }
  }
}
