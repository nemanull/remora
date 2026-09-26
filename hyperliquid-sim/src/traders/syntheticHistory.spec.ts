import {
  parseEvent,
  type HyperliquidFill,
  type PortfolioResponse,
} from '@remora/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Simulation } from '../simulation';
import type { LeaderboardRow } from './syntheticHistory';
import type { SyntheticWallet } from './syntheticWallets';

const STARTED_AT = 1_780_000_000_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const decimal = z.string().regex(/^-?\d+\.\d+$/);
const windowPerformance = z.strictObject({
  pnl: decimal,
  roi: decimal,
  vlm: decimal,
});
const leaderboardRowSchema = z.strictObject({
  ethAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
  accountValue: decimal,
  windowPerformances: z.tuple([
    z.tuple([z.literal('day'), windowPerformance]),
    z.tuple([z.literal('week'), windowPerformance]),
    z.tuple([z.literal('month'), windowPerformance]),
    z.tuple([z.literal('allTime'), windowPerformance]),
  ]),
  prize: z.literal(0),
  displayName: z.string().nullable(),
});
const vaultPnls = z.array(decimal).min(2);
const vaultRowSchema = z.strictObject({
  apr: z.number(),
  pnls: z.tuple([
    z.tuple([z.literal('day'), vaultPnls]),
    z.tuple([z.literal('week'), vaultPnls]),
    z.tuple([z.literal('month'), vaultPnls]),
    z.tuple([z.literal('allTime'), vaultPnls]),
  ]),
  summary: z.strictObject({
    name: z.string().min(1),
    vaultAddress: z.string().regex(/^0x[0-9a-f]{40}$/),
    leader: z.string().regex(/^0x[0-9a-f]{40}$/),
    tvl: decimal,
    isClosed: z.boolean(),
    relationship: z.strictObject({ type: z.literal('normal') }),
    createTimeMillis: z.number().int(),
  }),
});

type Window = 'day' | 'week' | 'month' | 'allTime';

function readWindow(row: LeaderboardRow, name: Window) {
  const entry = row.windowPerformances.find(([window]) => window === name);
  if (!entry) {
    throw new Error(`row has no ${name} window`);
  }
  return {
    pnl: Number(entry[1].pnl),
    vlm: Number(entry[1].vlm),
  };
}

function passesStageOneNumbers(row: LeaderboardRow): boolean {
  const accountValue = Number(row.accountValue);
  const month = readWindow(row, 'month');
  const allTime = readWindow(row, 'allTime');
  return (
    accountValue >= 100_000 &&
    month.vlm >= 1_000_000 &&
    month.vlm >= 0.5 * accountValue &&
    month.vlm <= 100 * accountValue &&
    allTime.pnl > 0 &&
    month.pnl > 0 &&
    allTime.pnl >= 0.0025 * allTime.vlm
  );
}

function readPortfolioWindow(portfolio: PortfolioResponse, name: string) {
  const entry = portfolio.find(([window]) => window === name);
  if (!entry) {
    throw new Error(`portfolio has no ${name} window`);
  }
  return entry[1];
}

function weeklyDrawdown(portfolio: PortfolioResponse): number {
  const allTime = readPortfolioWindow(portfolio, 'allTime');
  const points = allTime.accountValueHistory.map(([time, value], index) => ({
    time,
    accountValue: Number(value),
    pnl: Number(allTime.pnlHistory[index][1]),
  }));
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    const pnlChange = after.pnl - before.pnl;
    const flow = after.accountValue - before.accountValue - pnlChange;
    const base = before.accountValue + Math.max(flow, 0);
    if (base < 10_000) {
      continue;
    }
    equity *= 1 + pnlChange / base;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity / peak - 1);
  }
  return drawdown;
}

function measureBehaviour(fills: HyperliquidFill[], days: number) {
  const orders = new Set(fills.map((fill) => fill.oid)).size;
  const positions = new Map<string, number>();
  let openNotionalTime = 0;
  let openedNotional = 0;
  let previousTime = fills[0]?.time ?? 0;
  let openNotional = 0;
  for (const fill of fills) {
    openNotionalTime += openNotional * (fill.time - previousTime);
    previousTime = fill.time;
    const size = Number(fill.sz) * (fill.side === 'B' ? 1 : -1);
    const before = Number(fill.startPosition);
    const after = before + size;
    if (
      Math.abs(after) > Math.abs(before) ||
      Math.sign(after) !== Math.sign(before)
    ) {
      const opened =
        Math.sign(after) === Math.sign(before)
          ? Math.abs(after) - Math.abs(before)
          : Math.abs(after);
      openedNotional += opened * Number(fill.px);
    }
    positions.set(fill.coin, after * Number(fill.px));
    openNotional = [...positions.values()].reduce(
      (sum, value) => sum + Math.abs(value),
      0,
    );
  }
  const minutes = days * 1_440;
  const holdMinutes =
    openedNotional === 0
      ? Number.POSITIVE_INFINITY
      : openNotionalTime / MINUTE_MS / minutes / (openedNotional / minutes);
  return { ordersPerDay: orders / days, holdMinutes };
}

describe('SyntheticHistory', () => {
  const simulation = new Simulation({
    seed: 1,
    walletCount: 300,
    speed: 1,
    startedAt: STARTED_AT,
    clock: () => STARTED_AT,
  });
  const leaderboard = simulation.history.readLeaderboard(STARTED_AT);
  const vaultFile = simulation.history.readVaults(STARTED_AT);
  const vaultAddresses = new Set(
    vaultFile.map((vault) => vault.summary.vaultAddress),
  );
  const walletOf = (address: string): SyntheticWallet => {
    const wallet = simulation.findWallet(address);
    if (!wallet) {
      throw new Error(`unknown wallet ${address}`);
    }
    return wallet;
  };
  const survivors = leaderboard
    .filter((row) => !vaultAddresses.has(row.ethAddress))
    .filter(passesStageOneNumbers)
    .map((row) => walletOf(row.ethAddress));

  it('writes portfolio responses the sdk parser accepts with the eight real windows', () => {
    for (const wallet of simulation.wallets.slice(0, 20)) {
      const portfolio = simulation.history.readPortfolio(wallet, STARTED_AT);
      const parsed = parseEvent({
        type: 'event',
        wallet: wallet.address,
        channel: 'portfolio',
        source: 'poll',
        receivedAt: STARTED_AT,
        payload: portfolio,
      });
      expect(parsed.ok).toBe(true);
      expect(portfolio.map(([window]) => window)).toEqual([
        'day',
        'week',
        'month',
        'allTime',
        'perpDay',
        'perpWeek',
        'perpMonth',
        'perpAllTime',
      ]);
      for (const [, period] of portfolio) {
        expect(period.accountValueHistory.map(([time]) => time)).toEqual(
          period.pnlHistory.map(([time]) => time),
        );
        expect(period.accountValueHistory.at(-1)?.[0]).toBe(STARTED_AT);
        expect(period.pnlHistory[0][1]).toBe('0.0');
      }
      expect(
        readPortfolioWindow(portfolio, 'allTime').accountValueHistory[0][1],
      ).toBe('0.0');
    }
  });

  it('writes leaderboard rows and vault rows with the real schema', () => {
    expect(leaderboard.length).toBeGreaterThan(200);
    for (const row of leaderboard) {
      expect(leaderboardRowSchema.safeParse(row).success).toBe(true);
    }
    const monthVolumes = leaderboard.map((row) => readWindow(row, 'month').vlm);
    expect(monthVolumes).toEqual(
      [...monthVolumes].sort((left, right) => right - left),
    );
    for (const vault of vaultFile) {
      expect(vaultRowSchema.safeParse(vault).success).toBe(true);
    }
    expect(vaultFile.some((vault) => vault.summary.isClosed)).toBe(true);
  });

  it('agrees between the leaderboard and portfolio month volume', () => {
    for (const row of leaderboard.slice(0, 30)) {
      const portfolio = simulation.history.readPortfolio(
        walletOf(row.ethAddress),
        STARTED_AT,
      );
      expect(Number(readPortfolioWindow(portfolio, 'month').vlm)).toBeCloseTo(
        readWindow(row, 'month').vlm,
        0,
      );
    }
  });

  it('gives most wallets no edge', () => {
    const withoutEdge = simulation.wallets.filter(
      (wallet) => wallet.skill === 0,
    );
    expect(withoutEdge.length / simulation.wallets.length).toBeGreaterThan(0.7);
  });

  it('lets most planted-edge swing traders and some edge scalpers through stage one, and no vault', () => {
    const edgeSwing = simulation.wallets.filter(
      (wallet) => wallet.profile.name === 'swing' && wallet.hasEdge,
    );
    const survivingEdgeSwing = survivors.filter(
      (wallet) => wallet.profile.name === 'swing' && wallet.hasEdge,
    );
    expect(survivingEdgeSwing.length / edgeSwing.length).toBeGreaterThan(0.5);
    expect(
      survivors.some(
        (wallet) => wallet.profile.name === 'scalper' && wallet.hasEdge,
      ),
    ).toBe(true);
    expect(survivors.some((wallet) => wallet.vaultName !== null)).toBe(false);
    const numericVaults = leaderboard
      .filter((row) => vaultAddresses.has(row.ethAddress))
      .filter(passesStageOneNumbers);
    expect(numericVaults.length).toBeGreaterThan(0);
  });

  it('gives planted-edge survivors the history, drawdown and behaviour that pass the gates', () => {
    const edgeSwing = survivors.filter(
      (wallet) => wallet.profile.name === 'swing' && wallet.hasEdge,
    );
    for (const wallet of edgeSwing) {
      const portfolio = simulation.history.readPortfolio(wallet, STARTED_AT);
      const allTime = readPortfolioWindow(portfolio, 'allTime');
      expect(
        STARTED_AT - allTime.accountValueHistory[0][0],
      ).toBeGreaterThanOrEqual(182 * DAY_MS);
      expect(allTime.accountValueHistory.length).toBeGreaterThanOrEqual(27);
      expect(weeklyDrawdown(portfolio)).toBeGreaterThan(-0.5);
      const fills = simulation.traders.readFillsBetween(
        wallet,
        STARTED_AT - 30 * DAY_MS,
        STARTED_AT,
      );
      const behaviour = measureBehaviour(fills, 30);
      expect(behaviour.ordersPerDay).toBeLessThanOrEqual(50);
      expect(behaviour.ordersPerDay * 7).toBeGreaterThanOrEqual(2);
      expect(behaviour.holdMinutes).toBeGreaterThanOrEqual(60);
    }
  });

  it('makes scalpers fail the hold or activity gates', () => {
    const scalpers = survivors.filter(
      (wallet) => wallet.profile.name === 'scalper',
    );
    expect(scalpers.length).toBeGreaterThan(0);
    for (const wallet of scalpers) {
      const fills = simulation.traders.readFillsBetween(
        wallet,
        STARTED_AT - 30 * DAY_MS,
        STARTED_AT,
      );
      const behaviour = measureBehaviour(fills, 30);
      expect(behaviour.ordersPerDay > 50 || behaviour.holdMinutes < 60).toBe(
        true,
      );
    }
  });

  it('makes every reckless wallet fail the drawdown or the liquidation gate', () => {
    const reckless = simulation.wallets.filter(
      (wallet) => wallet.profile.name === 'reckless',
    );
    for (const wallet of reckless) {
      const drawdown = weeklyDrawdown(
        simulation.history.readPortfolio(wallet, STARTED_AT),
      );
      const liquidations = simulation.traders
        .readLedgerUpdates(wallet, STARTED_AT - 30 * DAY_MS, STARTED_AT)
        .filter((update) => update.delta.type === 'liquidation');
      expect(drawdown <= -0.5 || liquidations.length > 0).toBe(true);
    }
    expect(
      reckless.filter(
        (wallet) =>
          weeklyDrawdown(
            simulation.history.readPortfolio(wallet, STARTED_AT),
          ) <= -0.5,
      ).length,
    ).toBeGreaterThan(reckless.length / 2);
  });
});
