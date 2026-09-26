import { describe, expect, it } from 'vitest';
import { formatLots, formatPrice, toWireDecimal } from '../wireFormat';
import { SyntheticMarket, priceAwayFromMid } from './syntheticMarket';

const STARTED_AT = 1_780_000_000_000;
const HOUR_MS = 3_600_000;

describe('SyntheticMarket', () => {
  const market = new SyntheticMarket(5, STARTED_AT);

  it('formats prices with five significant figures and 6 minus szDecimals decimals', () => {
    expect(formatPrice(84_512.37, 5)).toBe('84512.0');
    expect(formatPrice(104_523.7, 5)).toBe('104524.0');
    expect(formatPrice(2_701.237, 4)).toBe('2701.2');
    expect(formatPrice(1.423_51, 0)).toBe('1.4235');
    expect(formatPrice(0.009_123_45, 0)).toBe('0.009123');
    expect(formatLots(342_300, 2)).toBe('3423.0');
    expect(toWireDecimal(-0.000_000_1, 6)).toBe('0.0');
  });

  it('walks the same mids for the same seed', () => {
    const again = new SyntheticMarket(5, STARTED_AT);
    const other = new SyntheticMarket(6, STARTED_AT);
    for (const time of [
      STARTED_AT - 200 * 24 * HOUR_MS,
      STARTED_AT,
      STARTED_AT + 48 * HOUR_MS,
    ]) {
      expect(again.readMidAt('BTC', time)).toBe(market.readMidAt('BTC', time));
      expect(other.readMidAt('BTC', time)).not.toBe(
        market.readMidAt('BTC', time),
      );
    }
  });

  it('moves mids by a few basis points per second at most', () => {
    for (const coin of market.coins) {
      const before = market.readMidAt(coin.name, STARTED_AT);
      const after = market.readMidAt(coin.name, STARTED_AT + 1_000);
      expect(Math.abs(after / before - 1)).toBeLessThan(0.002);
    }
  });

  it('builds strictly ordered books of 20 levels that never cross', () => {
    for (const coin of market.coins) {
      const [bids, asks] = market.readBook(coin.name, STARTED_AT).levels;
      expect(bids).toHaveLength(20);
      expect(asks).toHaveLength(20);
      for (let level = 1; level < 20; level += 1) {
        expect(Number(bids[level].px)).toBeLessThan(Number(bids[level - 1].px));
        expect(Number(asks[level].px)).toBeGreaterThan(
          Number(asks[level - 1].px),
        );
      }
      expect(Number(bids[0].px)).toBeLessThan(Number(asks[0].px));
      expect(Number(bids[0].sz)).toBeGreaterThan(0);
    }
  });

  it('prices taker fills through the mid on the side they take', () => {
    const mid = market.readMidAt('ETH', STARTED_AT);
    expect(priceAwayFromMid(mid, 4, true, 0.0001)).toBeGreaterThan(mid);
    expect(priceAwayFromMid(mid, 4, false, 0.0001)).toBeLessThan(mid);
  });

  it('serves consistent candles and at most 5,000 of them', () => {
    const candles = market.readCandles(
      'SOL',
      '15m',
      STARTED_AT - 24 * HOUR_MS,
      STARTED_AT,
      STARTED_AT,
    );
    expect(candles.length).toBeGreaterThanOrEqual(96);
    for (const candle of candles) {
      expect(Number(candle.h)).toBeGreaterThanOrEqual(
        Math.max(Number(candle.o), Number(candle.c)),
      );
      expect(Number(candle.l)).toBeLessThanOrEqual(
        Math.min(Number(candle.o), Number(candle.c)),
      );
    }
    expect(
      market.readCandles('SOL', '1m', 0, STARTED_AT, STARTED_AT),
    ).toHaveLength(5_000);
  });

  it('settles a constant funding rate every hour', () => {
    const items = market.readFundingHistory(
      'BTC',
      STARTED_AT - 5 * HOUR_MS,
      STARTED_AT,
    );
    expect(items.map((item) => item.time % HOUR_MS)).toEqual([0, 0, 0, 0, 0]);
    expect(new Set(items.map((item) => item.fundingRate)).size).toBe(1);
  });

  it('marks isolated-only markets in the universe', () => {
    const isolated = market
      .readUniverse()
      .filter((asset) => asset.onlyIsolated);
    expect(isolated.map((asset) => asset.marginMode)).toEqual(['noCross']);
  });
});
