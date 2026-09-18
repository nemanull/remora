import type { HyperliquidFill } from '@remora/sdk';

export const FILLS_PAGE_SIZE = 2_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export type MarketKind = 'main_perp' | 'builder_perp' | 'other';

export type FillWindow = {
  from: number;
  to: number;
};

export type ScoredFill = Pick<
  HyperliquidFill,
  | 'coin'
  | 'px'
  | 'sz'
  | 'side'
  | 'time'
  | 'startPosition'
  | 'oid'
  | 'crossed'
  | 'tid'
>;

export type FillPages = {
  fills: ScoredFill[];
  firstPageFull: boolean;
  reachedPageLimit: boolean;
};

export type FillBehaviour = {
  holdMinutes: number | null;
  ordersPerDay: number;
  copyableOrdersPerWeek: number;
  makerShare: number | null;
  coreNotionalShare: number | null;
};

type HeldPosition = {
  size: number;
  price: number;
  since: number;
};

export function classifyMarket(coin: string): MarketKind {
  if (coin.startsWith('@') || coin.startsWith('#') || coin.includes('/')) {
    return 'other';
  }
  return coin.includes(':') ? 'builder_perp' : 'main_perp';
}

export function measureCoveredWindow(
  pages: FillPages,
  requested: FillWindow,
): FillWindow {
  const { fills } = pages;
  if (fills.length === 0) {
    return requested;
  }
  return {
    from: pages.firstPageFull ? fills[0].time : requested.from,
    to: pages.reachedPageLimit ? fills[fills.length - 1].time : requested.to,
  };
}

function readPositionAfter(fill: ScoredFill): number {
  const size = Number(fill.sz);
  return Number(fill.startPosition) + (fill.side === 'B' ? size : -size);
}

function readOpenedSize(before: number, after: number): number {
  if (before === 0 || Math.sign(after) === -Math.sign(before)) {
    return Math.abs(after);
  }
  return Math.max(Math.abs(after) - Math.abs(before), 0);
}

function measureHoldMinutes(
  fills: ScoredFill[],
  window: FillWindow,
): number | null {
  const positions = new Map<string, HeldPosition>();
  let heldNotionalMinutes = 0;
  let openedNotional = 0;
  const holdUntil = (position: HeldPosition, time: number) => {
    const heldMs = Math.max(time - position.since, 0);
    heldNotionalMinutes +=
      (Math.abs(position.size) * position.price * heldMs) / MINUTE_MS;
  };
  for (const fill of fills) {
    const price = Number(fill.px);
    const before = Number(fill.startPosition);
    const after = readPositionAfter(fill);
    holdUntil(
      positions.get(fill.coin) ?? { size: before, price, since: window.from },
      fill.time,
    );
    positions.set(fill.coin, { size: after, price, since: fill.time });
    openedNotional += readOpenedSize(before, after) * price;
  }
  for (const position of positions.values()) {
    holdUntil(position, window.to);
  }
  return openedNotional > 0 ? heldNotionalMinutes / openedNotional : null;
}

function sumNotional(fills: ScoredFill[]): number {
  return fills.reduce(
    (sum, fill) => sum + Number(fill.px) * Number(fill.sz),
    0,
  );
}

function countOrders(fills: ScoredFill[]): number {
  return new Set(fills.map((fill) => fill.oid)).size;
}

export function measureFillBehaviour(
  fills: ScoredFill[],
  window: FillWindow,
): FillBehaviour {
  const perpFills = fills.filter(
    (fill) => classifyMarket(fill.coin) !== 'other',
  );
  const mainFills = perpFills.filter(
    (fill) => classifyMarket(fill.coin) === 'main_perp',
  );
  const durationMs = Math.max(window.to - window.from, MINUTE_MS);
  const perpNotional = sumNotional(perpFills);
  const mainNotional = sumNotional(mainFills);
  const makerNotional = sumNotional(mainFills.filter((fill) => !fill.crossed));
  return {
    holdMinutes: measureHoldMinutes(mainFills, window),
    ordersPerDay: countOrders(perpFills) / (durationMs / DAY_MS),
    copyableOrdersPerWeek: countOrders(mainFills) / (durationMs / WEEK_MS),
    makerShare: mainNotional > 0 ? makerNotional / mainNotional : null,
    coreNotionalShare: perpNotional > 0 ? mainNotional / perpNotional : null,
  };
}
