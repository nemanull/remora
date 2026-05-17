import type { HyperliquidWsFill } from '@remora/sdk';
import { Decimal } from 'decimal.js';

export type WalletStats = {
  wallet: string;
  fills: number;
  closes: number;
  wins: number;
  winRate: number;
  realizedPnl: Decimal;
  fees: Decimal;
  netPnl: Decimal;
  volume: Decimal;
  accountValue: Decimal;
  roi: Decimal;
};

export type WalletScore = WalletStats & {
  score: number;
};

// weights are random for now
const WIN_RATE_WEIGHT = 0.4;
const ROI_WEIGHT = 0.4;
const ACTIVITY_WEIGHT = 0.2;
const FULL_ACTIVITY_CLOSES = 50;

export function computeWalletStats(
  wallet: string,
  fills: HyperliquidWsFill[],
  accountValue: Decimal,
): WalletStats {
  let closes = 0;
  let wins = 0;
  let realizedPnl = new Decimal(0);
  let fees = new Decimal(0);
  let volume = new Decimal(0);

  for (const fill of fills) {
    const pnl = new Decimal(fill.closedPnl);
    realizedPnl = realizedPnl.plus(pnl);
    fees = fees.plus(fill.fee);
    volume = volume.plus(new Decimal(fill.px).times(fill.sz));
    if (fill.dir.startsWith('Close')) {
      closes++;
      if (pnl.gt(0)) wins++;
    }
  }

  const netPnl = realizedPnl.minus(fees);

  return {
    wallet,
    fills: fills.length,
    closes,
    wins,
    winRate: closes > 0 ? wins / closes : 0,
    realizedPnl,
    fees,
    netPnl,
    volume,
    accountValue,
    roi: accountValue.gt(0) ? netPnl.div(accountValue) : new Decimal(0),
  };
}

export function computeScore(stats: WalletStats): number {
  const roiScore = Decimal.min(Decimal.max(stats.roi, 0), 1);
  const activityScore = Math.min(stats.closes / FULL_ACTIVITY_CLOSES, 1);
  const score = roiScore
    .times(ROI_WEIGHT)
    .plus(stats.winRate * WIN_RATE_WEIGHT)
    .plus(activityScore * ACTIVITY_WEIGHT);

  return score.toDecimalPlaces(4).toNumber();
}

export function rankByScore(stats: WalletStats[]): WalletScore[] {
  return stats
    .map((walletStats) => ({
      ...walletStats,
      score: computeScore(walletStats),
    }))
    .sort((a, b) => b.score - a.score);
}
