import type { HyperliquidWsFill } from '@remora/sdk';

const LEADERBOARD_URL =
  'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const INFO_URL = 'https://api.hyperliquid.xyz/info';
const MIN_ACCOUNT_VALUE = 100_000;

export type LeaderboardWindow = 'day' | 'week' | 'month' | 'allTime';

export type WindowPerformance = {
  pnl: string;
  roi: string;
  vlm: string;
};

export type LeaderboardRow = {
  ethAddress: string;
  accountValue: string;
  windowPerformances: [LeaderboardWindow, WindowPerformance][];
  prize: number;
  displayName: string | null;
};

type LeaderboardFile = {
  leaderboardRows: LeaderboardRow[];
};

// TODO: the file is huge, dont parse it every run
export async function fetchLeaderboard(): Promise<LeaderboardRow[]> {
  const response = await fetch(LEADERBOARD_URL);
  if (!response.ok) {
    throw new Error(`Leaderboard request failed with ${response.status}`);
  }

  const file = (await response.json()) as LeaderboardFile;
  return file.leaderboardRows;
}

export function getWindowPnl(
  row: LeaderboardRow,
  window: LeaderboardWindow,
): number {
  const performance = row.windowPerformances.find(([name]) => name === window);
  return performance ? parseFloat(performance[1].pnl) : 0;
}

export function filterCandidates(rows: LeaderboardRow[]): LeaderboardRow[] {
  return rows.filter(
    (row) =>
      parseFloat(row.accountValue) >= MIN_ACCOUNT_VALUE &&
      getWindowPnl(row, 'month') > 0 &&
      getWindowPnl(row, 'allTime') > 0,
  );
}

// weight 20, 1200 per minute per ip
export async function fetchFills(wallet: string): Promise<HyperliquidWsFill[]> {
  const response = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'userFills', user: wallet }),
  });
  if (!response.ok) {
    throw new Error(
      `userFills request failed for wallet ${wallet} with ${response.status}`,
    );
  }

  return (await response.json()) as HyperliquidWsFill[];
}
