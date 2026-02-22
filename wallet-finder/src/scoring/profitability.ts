import type { HyperliquidWsFill } from '@copy-quant/sdk';

export type WalletStats = {
  wallet: string;
  fills: number;
  closes: number;
  wins: number;
  winRate: number;
  realizedPnl: number;
  fees: number;
  netPnl: number;
  volume: number;
  accountValue: number;
  roi: number;
};

export type WalletScore = WalletStats & {
  score: number;
};

// weights are random for now
const WIN_RATE_WEIGHT = 0.4;
const ROI_WEIGHT = 0.4;
const ACTIVITY_WEIGHT = 0.2;
const FULL_ACTIVITY_CLOSES = 50;

// TODO: floats are off in the last digits, use a decimal lib
export function computeWalletStats(
  wallet: string,
  fills: HyperliquidWsFill[],
  accountValue: number,
): WalletStats {
  let closes = 0;
  let wins = 0;
  let realizedPnl = 0;
  let fees = 0;
  let volume = 0;

  for (const fill of fills) {
    const pnl = parseFloat(fill.closedPnl);
    realizedPnl += pnl;
    fees += parseFloat(fill.fee);
    volume += parseFloat(fill.px) * parseFloat(fill.sz);
    if (fill.dir.startsWith('Close')) {
      closes++;
      if (pnl > 0) wins++;
    }
  }

  const netPnl = realizedPnl - fees;

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
    roi: accountValue > 0 ? netPnl / accountValue : 0,
  };
}

export function computeScore(stats: WalletStats): number {
  const roiScore = Math.min(Math.max(stats.roi, 0), 1);
  const activityScore = Math.min(stats.closes / FULL_ACTIVITY_CLOSES, 1);
  const score =
    stats.winRate * WIN_RATE_WEIGHT +
    roiScore * ROI_WEIGHT +
    activityScore * ACTIVITY_WEIGHT;

  return Math.round(score * 10_000) / 10_000;
}

export function rankByScore(stats: WalletStats[]): WalletScore[] {
  return stats
    .map((walletStats) => ({
      ...walletStats,
      score: computeScore(walletStats),
    }))
    .sort((a, b) => b.score - a.score);
}
