import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { type BookLevel, walkBook } from './bookWalk';

function levels(...entries: [string, string][]): BookLevel[] {
  return entries.map(([price, size]) => ({
    price: new Decimal(price),
    size: new Decimal(size),
  }));
}

function walk(
  side: BookLevel[],
  isBuy: boolean,
  size: string,
  limitPx: string,
): [string, string | null] {
  const result = walkBook(side, isBuy, new Decimal(size), new Decimal(limitPx));
  return [result.filledSize.toFixed(), result.averagePrice?.toFixed() ?? null];
}

describe('walkBook', () => {
  const asks = levels(['100', '1'], ['101', '2'], ['103', '5']);
  const bids = levels(['99', '1'], ['98', '2'], ['95', '5']);

  it('fills a buy across ask levels at their volume weighted price', () => {
    expect(walk(asks, true, '2.5', '102')).toEqual(['2.5', '100.6']);
  });

  it('stops a buy at the limit price and fills part of the order', () => {
    expect(walk(asks, true, '5', '101')).toEqual([
      '3',
      '100.66666666666666667',
    ]);
  });

  it('fills a sell down the bids until the limit', () => {
    expect(walk(bids, false, '4', '98')).toEqual([
      '3',
      '98.333333333333333333',
    ]);
  });

  it('takes a level exactly at the limit', () => {
    expect(walk(asks, true, '1', '100')).toEqual(['1', '100']);
  });

  it('fills nothing when the best level is beyond the limit', () => {
    expect(walk(asks, true, '1', '99.9')).toEqual(['0', null]);
    expect(walk(bids, false, '1', '99.1')).toEqual(['0', null]);
  });

  it('fills nothing on an empty side', () => {
    expect(walk([], true, '1', '1000')).toEqual(['0', null]);
  });

  it('never fills more than the order size', () => {
    expect(walk(asks, true, '0.4', '200')).toEqual(['0.4', '100']);
  });
});
