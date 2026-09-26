import type { HyperliquidFill } from '@remora/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Simulation } from '../simulation';
import type { SyntheticWallet } from './syntheticWallets';

const STARTED_AT = 1_780_000_000_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function createSimulation(seed = 7, speed = 1, walletCount = 40): Simulation {
  return new Simulation({
    seed,
    walletCount,
    speed,
    startedAt: STARTED_AT,
    clock: () => STARTED_AT,
  });
}

function toLots(value: string, coinDecimals: number): number {
  return Math.round(Number(value) * 10 ** coinDecimals);
}

function signedLots(fill: HyperliquidFill, coinDecimals: number): number {
  const lots = toLots(fill.sz, coinDecimals);
  return fill.side === 'B' ? lots : -lots;
}

describe('SyntheticTraders', () => {
  const simulation = createSimulation();
  const decimalsOf = (coin: string) =>
    simulation.market.findCoin(coin)?.szDecimals ?? 0;
  const fillsOf = (wallet: SyntheticWallet, days = 10) =>
    simulation.traders.readFillsBetween(
      wallet,
      STARTED_AT - days * DAY_MS,
      STARTED_AT,
    );

  it('keeps every startPosition chain consistent per wallet and coin', () => {
    let checkedPairs = 0;
    for (const wallet of simulation.wallets) {
      const positions = new Map<string, number>();
      for (const fill of fillsOf(wallet)) {
        const decimals = decimalsOf(fill.coin);
        const start = toLots(fill.startPosition, decimals);
        const expected = positions.get(fill.coin);
        if (expected !== undefined) {
          expect(start).toBe(expected);
          checkedPairs += 1;
        }
        positions.set(fill.coin, start + signedLots(fill, decimals));
      }
    }
    expect(checkedPairs).toBeGreaterThan(1_000);
  });

  it('labels every fill with the direction its positions imply', () => {
    for (const wallet of simulation.wallets.slice(0, 10)) {
      for (const fill of fillsOf(wallet, 3)) {
        const decimals = decimalsOf(fill.coin);
        const start = toLots(fill.startPosition, decimals);
        const end = start + signedLots(fill, decimals);
        if (start === 0) {
          expect(fill.dir).toBe(end > 0 ? 'Open Long' : 'Open Short');
        } else if (start > 0 && end > start) {
          expect(fill.dir).toBe('Open Long');
        } else if (start > 0) {
          expect(fill.dir).toBe(end >= 0 ? 'Close Long' : 'Long > Short');
        } else if (end < start) {
          expect(fill.dir).toBe('Open Short');
        } else {
          expect(fill.dir).toBe(end <= 0 ? 'Close Short' : 'Short > Long');
        }
        if (fill.dir.startsWith('Open')) {
          expect(fill.closedPnl).toBe('0.0');
        }
      }
    }
  });

  it('gives every fill a unique tid and every order a unique oid shared by its fills', () => {
    const tids = new Set<number>();
    const orderKeys = new Map<number, string>();
    let fillCount = 0;
    for (const wallet of simulation.wallets) {
      for (const fill of fillsOf(wallet)) {
        tids.add(fill.tid);
        fillCount += 1;
        const key = `${wallet.address}|${fill.coin}|${fill.time}|${fill.hash}|${fill.side}`;
        expect(orderKeys.get(fill.oid) ?? key).toBe(key);
        orderKeys.set(fill.oid, key);
        expect(Number.isSafeInteger(fill.tid)).toBe(true);
      }
    }
    expect(tids.size).toBe(fillCount);
  });

  it('charges taker and maker fees on the filled notional', () => {
    for (const fill of fillsOf(simulation.wallets[0], 5)) {
      const rate = fill.crossed ? 0.00045 : 0.00015;
      expect(Number(fill.fee)).toBeCloseTo(
        Number(fill.px) * Number(fill.sz) * rate,
        5,
      );
    }
  });

  it('emits each order once with all of its fills across consecutive windows', () => {
    const wallet = simulation.wallets.find(
      (candidate) => candidate.profile.name === 'scalper',
    );
    if (!wallet) {
      throw new Error('the population has no scalper');
    }
    const start = STARTED_AT - DAY_MS;
    const whole = simulation.traders.readOrdersBetween(
      wallet,
      start,
      start + 6 * HOUR_MS,
    );
    const pieces = [0, 1, 2, 3, 4, 5].flatMap((hour) =>
      simulation.traders.readOrdersBetween(
        wallet,
        start + hour * HOUR_MS,
        start + (hour + 1) * HOUR_MS,
      ),
    );
    expect(pieces.map((order) => order.oid)).toEqual(
      whole.map((order) => order.oid),
    );
    for (const order of whole) {
      expect(order.fills.length).toBeGreaterThanOrEqual(1);
      expect(order.fills.length).toBeLessThanOrEqual(20);
      expect(new Set(order.fills.map((fill) => fill.oid))).toEqual(
        new Set([order.oid]),
      );
      expect(new Set(order.fills.map((fill) => fill.time))).toEqual(
        new Set([order.time]),
      );
    }
  });

  it('serves the last fills of a wallet for a snapshot', () => {
    const wallet = simulation.wallets[3];
    const all = simulation.traders.readFillsBetween(wallet, 0, STARTED_AT);
    expect(
      simulation.traders.readRecentFills(wallet, 0, STARTED_AT, 30),
    ).toEqual(all.slice(-30));
  });

  it('reports positions that match the end of each fill chain', () => {
    for (const wallet of simulation.wallets.slice(0, 15)) {
      const expected = new Map<string, number>();
      for (const fill of simulation.traders.readFillsBetween(
        wallet,
        STARTED_AT - 2 * DAY_MS,
        STARTED_AT,
      )) {
        const decimals = decimalsOf(fill.coin);
        expected.set(
          fill.coin,
          toLots(fill.startPosition, decimals) + signedLots(fill, decimals),
        );
      }
      const open = [...expected].filter(([, lots]) => lots !== 0);
      const positions = simulation.traders
        .readPositions(wallet, STARTED_AT)
        .map((position) => [position.coin, position.lots]);
      expect(positions.sort()).toEqual(open.sort());
    }
  });

  it('liquidates every reckless wallet within the last 30 days and nobody else', () => {
    for (const wallet of simulation.wallets) {
      const since = STARTED_AT - 30 * DAY_MS;
      const liquidationFills = simulation.traders
        .readFillsBetween(wallet, since, STARTED_AT)
        .filter((fill) => fill.liquidation !== undefined);
      const ledgerLiquidations = simulation.traders
        .readLedgerUpdates(wallet, since, STARTED_AT)
        .filter((update) => update.delta.type === 'liquidation');
      if (wallet.profile.name === 'reckless') {
        expect(liquidationFills.length).toBeGreaterThan(0);
        expect(ledgerLiquidations.length).toBeGreaterThan(0);
        expect(liquidationFills[0].liquidation?.liquidatedUser).toBe(
          wallet.address,
        );
      } else {
        expect(liquidationFills).toEqual([]);
        expect(ledgerLiquidations).toEqual([]);
      }
    }
  });

  it('produces the same fills from the same seed and different fills from another', () => {
    const wallet = simulation.wallets[5];
    const again = createSimulation();
    const other = createSimulation(8);
    expect(fillsOf(again.wallets[5], 3)).toEqual(fillsOf(wallet, 3));
    expect(other.wallets[5].address).not.toBe(wallet.address);
  });

  it('speeds up trading from the start of the simulation, whatever the slot phase', () => {
    const fast = createSimulation(7, 30);
    const swing = fast.wallets.filter(
      (wallet) => wallet.profile.name === 'swing',
    );
    const ordersInFirstHour = swing.reduce(
      (sum, wallet) =>
        sum +
        fast.traders.readOrdersBetween(wallet, STARTED_AT, STARTED_AT + HOUR_MS)
          .length,
      0,
    );
    expect(ordersInFirstHour / swing.length).toBeGreaterThan(5);
  });

  it('trades more often after the start when the speed is raised', () => {
    const slow = createSimulation(7, 1);
    const fast = createSimulation(7, 10);
    const countOrders = (target: Simulation) =>
      target.wallets
        .filter((wallet) => wallet.profile.name === 'swing')
        .reduce(
          (sum, wallet) =>
            sum +
            target.traders.readOrdersBetween(
              wallet,
              STARTED_AT + 12 * HOUR_MS,
              STARTED_AT + 36 * HOUR_MS,
            ).length,
          0,
        );
    expect(countOrders(fast)).toBeGreaterThan(countOrders(slow) * 5);
  });

  it('writes fills with the keys of the captured userFills payload', () => {
    const captured = JSON.parse(
      readFileSync(
        join(__dirname, '../../../payloads/userFills/snapshot.json'),
        'utf8',
      ),
    ) as { data: { fills: Record<string, unknown>[] } };
    const capturedKeys = Object.keys(captured.data.fills[0]).sort();
    const fill = fillsOf(simulation.wallets[0], 5).find(
      (candidate) => candidate.liquidation === undefined,
    );
    expect(Object.keys(fill ?? {}).sort()).toEqual(capturedKeys);
  });
});
