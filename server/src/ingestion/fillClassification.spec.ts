import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  isMainDexPerp,
  positionAfter,
  summarizeFills,
  type ClassifiedFill,
} from './fillClassification';

const MARKETS = new Map([
  ['BTC', {}],
  ['HYPE', {}],
  ['kBONK', {}],
]);

let nextTid = 1n;

function fill(
  side: 'B' | 'A',
  size: string,
  startPosition: string,
  price = '100',
): ClassifiedFill {
  const tid = nextTid;
  nextTid += 1n;
  return {
    tid,
    price: new Decimal(price),
    size: new Decimal(size),
    isBuy: side === 'B',
    startPosition: new Decimal(startPosition),
    time: new Date(1_769_674_533_776 + Number(tid)),
  };
}

describe('isMainDexPerp', () => {
  it.each([
    ['BTC', true],
    ['kBONK', true],
    ['xyz:MU', false],
    ['@107', false],
    ['#20', false],
    ['PURR/USDC', false],
    ['DOGE', false],
  ])('classifies %s as main-dex perp: %s', (coin, expected) => {
    expect(isMainDexPerp(coin, MARKETS)).toBe(expected);
  });
});

describe('positionAfter', () => {
  it('adds a buy and subtracts a sell from the start position', () => {
    expect(positionAfter(fill('B', '2.5', '-1')).toString()).toBe('1.5');
    expect(positionAfter(fill('A', '3', '1')).toString()).toBe('-2');
  });
});

describe('summarizeFills', () => {
  it('reports an open from flat as an episode that began inside the signal', () => {
    const open = fill('B', '3', '0', '31.5');

    const summary = summarizeFills([open]);

    expect(summary.positionBefore.toString()).toBe('0');
    expect(summary.positionAfter.toString()).toBe('3');
    expect(summary.touchedZero).toBe(false);
    expect(summary.episodeOpenTid).toBe(open.tid);
    expect(summary.vwap.toString()).toBe('31.5');
  });

  it('reports an increase of an older position as an episode that began earlier', () => {
    const summary = summarizeFills([fill('B', '1', '2')]);

    expect(summary.positionBefore.toString()).toBe('2');
    expect(summary.positionAfter.toString()).toBe('3');
    expect(summary.touchedZero).toBe(false);
    expect(summary.episodeOpenTid).toBeNull();
  });

  it('reports a reduce without a zero touch', () => {
    const summary = summarizeFills([fill('A', '1', '3')]);

    expect(summary.positionAfter.toString()).toBe('2');
    expect(summary.touchedZero).toBe(false);
    expect(summary.episodeOpenTid).toBeNull();
  });

  it('reports a close as a zero touch with the VWAP of the closing fills', () => {
    const summary = summarizeFills([
      fill('A', '2', '5', '110'),
      fill('A', '3', '3', '108'),
    ]);

    expect(summary.positionAfter.toString()).toBe('0');
    expect(summary.touchedZero).toBe(true);
    expect(summary.episodeOpenTid).toBeNull();
    expect(summary.vwap.toString()).toBe('108.8');
  });

  it('reports a flip as a zero touch that opens a new episode at the flip price', () => {
    const flip = fill('A', '5', '2', '95');

    const summary = summarizeFills([flip]);

    expect(summary.positionBefore.toString()).toBe('2');
    expect(summary.positionAfter.toString()).toBe('-3');
    expect(summary.touchedZero).toBe(true);
    expect(summary.episodeOpenTid).toBe(flip.tid);
    expect(summary.vwap.toString()).toBe('95');
  });

  it('reports equal positions before and after a round trip inside one signal', () => {
    const summary = summarizeFills([fill('B', '1', '2'), fill('A', '1', '3')]);

    expect(summary.positionBefore.eq(summary.positionAfter)).toBe(true);
    expect(summary.touchedZero).toBe(false);
  });

  it('summarizes the scale-in burst of the snapshot that ends flat', () => {
    const summary = summarizeFills([
      fill('A', '5310.0', '0.0', '0.003017'),
      fill('A', '5317.0', '-5310.0', '0.003009'),
      fill('B', '10627.0', '-10627.0', '0.003011'),
    ]);

    expect(summary.positionBefore.toString()).toBe('0');
    expect(summary.positionAfter.toString()).toBe('0');
    expect(summary.touchedZero).toBe(true);
    expect(summary.episodeOpenTid).toBeNull();
    expect(summary.vwap.toString()).toBe('0.003011');
  });

  it('weights the VWAP of a scale-in by size', () => {
    const summary = summarizeFills([
      fill('A', '5310.0', '0.0', '0.003017'),
      fill('A', '5317.0', '-5310.0', '0.003009'),
    ]);

    expect(summary.positionAfter.toString()).toBe('-10627');
    expect(summary.vwap.toFixed(9)).toBe('0.003012997');
  });

  it('restarts the VWAP and the episode after a burst touches zero', () => {
    const reopen = fill('B', '2', '0', '120');

    const summary = summarizeFills([fill('A', '5', '5', '100'), reopen]);

    expect(summary.touchedZero).toBe(true);
    expect(summary.positionAfter.toString()).toBe('2');
    expect(summary.episodeOpenTid).toBe(reopen.tid);
    expect(summary.vwap.toString()).toBe('120');
  });

  it('detects a zero touch hidden between two fills of a catch-up', () => {
    const afterGap = fill('A', '1', '-3', '90');

    const summary = summarizeFills([fill('B', '5', '0', '100'), afterGap]);

    expect(summary.touchedZero).toBe(true);
    expect(summary.positionAfter.toString()).toBe('-4');
    expect(summary.episodeOpenTid).toBe(afterGap.tid);
    expect(summary.vwap.toString()).toBe('90');
  });

  it('takes the position after from the last fill when a move was never seen', () => {
    const summary = summarizeFills([fill('B', '5', '0'), fill('B', '2', '3')]);

    expect(summary.positionAfter.toString()).toBe('5');
    expect(summary.touchedZero).toBe(false);
  });

  it('refuses an empty list', () => {
    expect(() => summarizeFills([])).toThrow();
  });
});
