import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  type CopyGap,
  type EpisodeFill,
  type GapOrder,
  splitCopyGap,
  summarizeLeaderEpisode,
} from './copyGap';

const TAKER_FEE = new Decimal('0.00045');

function order(
  purpose: GapOrder['purpose'],
  isBuy: boolean,
  filledSize: string,
  averagePrice: string | null,
  referencePrice: string,
): GapOrder {
  return {
    purpose,
    isBuy,
    filledSize: new Decimal(filledSize),
    averagePrice: averagePrice === null ? null : new Decimal(averagePrice),
    referencePrice: new Decimal(referencePrice),
  };
}

function closedCopy(size: string, extraOrders: GapOrder[] = []) {
  const held = new Decimal(size);
  const entryPrice = new Decimal('100.5');
  const exitPrice = new Decimal('109.8');
  return {
    ratio: new Decimal('0.01'),
    realizedPnl: exitPrice.minus(entryPrice).mul(held),
    feesUsd: entryPrice.plus(exitPrice).mul(held).mul(TAKER_FEE),
    fundingUsd: held.mul('-0.1'),
    leaderClosedPnl: new Decimal(100),
    leaderFeesUsd: new Decimal('0.945'),
    orders: [
      order('ENTRY', true, size, '100.5', '100'),
      order('EXIT', false, size, '109.8', '110'),
      ...extraOrders,
    ],
  };
}

function sumOfParts(gap: CopyGap): Decimal {
  return gap.entryDrift
    .plus(gap.exitDrift)
    .plus(gap.feeDifference)
    .plus(gap.funding)
    .plus(gap.residual);
}

function texts(gap: CopyGap): Record<keyof CopyGap, string> {
  return {
    copyPnl: gap.copyPnl.toFixed(),
    scaledLeaderPnl: gap.scaledLeaderPnl.toFixed(),
    totalGap: gap.totalGap.toFixed(),
    entryDrift: gap.entryDrift.toFixed(),
    exitDrift: gap.exitDrift.toFixed(),
    feeDifference: gap.feeDifference.toFixed(),
    funding: gap.funding.toFixed(),
    residual: gap.residual.toFixed(),
  };
}

describe('splitCopyGap', () => {
  it('splits a proportional copy into drift, fees and funding with no residual', () => {
    const gap = splitCopyGap(closedCopy('0.1'));

    expect(texts(gap)).toEqual({
      copyPnl: '0.9105365',
      scaledLeaderPnl: '0.99055',
      totalGap: '-0.0800135',
      entryDrift: '-0.05',
      exitDrift: '-0.02',
      feeDifference: '-0.0000135',
      funding: '-0.01',
      residual: '0',
    });
    expect(sumOfParts(gap).equals(gap.totalGap)).toBe(true);
  });

  it('leaves the size the copy never held in the residual', () => {
    const gap = splitCopyGap(closedCopy('0.09'));

    expect(gap.residual.toFixed()).toBe('-0.1');
    expect(gap.entryDrift.toFixed()).toBe('-0.045');
    expect(gap.exitDrift.toFixed()).toBe('-0.018');
    expect(sumOfParts(gap).equals(gap.totalGap)).toBe(true);
  });

  it('counts stop and reconciliation fills as exits and skips unfilled orders', () => {
    const gap = splitCopyGap({
      ...closedCopy('0.1'),
      orders: [
        order('ENTRY', true, '0.1', '100.5', '100'),
        order('ENTRY', true, '0', null, '100'),
        order('STOP', false, '0.06', '109.9', '110'),
        order('RECONCILE', false, '0.04', '109.65', '110'),
      ],
    });

    expect(gap.entryDrift.toFixed()).toBe('-0.05');
    expect(gap.exitDrift.toFixed()).toBe('-0.02');
    expect(sumOfParts(gap).equals(gap.totalGap)).toBe(true);
  });

  it('adds up for a losing short copy', () => {
    const gap = splitCopyGap({
      ratio: new Decimal('0.0025'),
      realizedPnl: new Decimal('-12.34'),
      feesUsd: new Decimal('1.1'),
      fundingUsd: new Decimal('0.37'),
      leaderClosedPnl: new Decimal('-4000'),
      leaderFeesUsd: new Decimal('210'),
      orders: [
        order('ENTRY', false, '1.5', '2990', '3000'),
        order('EXIT', true, '1.5', '3011', '3004'),
      ],
    });

    expect(gap.entryDrift.toFixed()).toBe('-15');
    expect(gap.exitDrift.toFixed()).toBe('-10.5');
    expect(sumOfParts(gap).equals(gap.totalGap)).toBe(true);
  });
});

function fill(
  tid: number,
  isBuy: boolean,
  size: string,
  startPosition: string,
  closedPnl: string,
  fee: string,
): EpisodeFill {
  return {
    tid: BigInt(tid),
    isBuy,
    size: new Decimal(size),
    startPosition: new Decimal(startPosition),
    closedPnl: new Decimal(closedPnl),
    fee: new Decimal(fee),
  };
}

function episodeTexts(fills: EpisodeFill[], openTid: number) {
  const episode = summarizeLeaderEpisode(fills, BigInt(openTid));
  return episode === null
    ? null
    : {
        closedPnl: episode.closedPnl.toFixed(),
        feesUsd: episode.feesUsd.toFixed(),
        isClosed: episode.isClosed,
      };
}

describe('summarizeLeaderEpisode', () => {
  it('sums a long episode from the opening fill to the close and ignores what follows', () => {
    const fills = [
      fill(10, false, '2', '2', '3', '0.09'),
      fill(11, true, '1', '0', '0', '0.05'),
      fill(12, true, '0.5', '1', '0', '0.02'),
      fill(13, false, '0.5', '1.5', '5', '0.02'),
      fill(14, false, '1', '1', '12', '0.04'),
      fill(15, true, '4', '0', '0', '0.18'),
    ];

    expect(episodeTexts(fills, 11)).toEqual({
      closedPnl: '17',
      feesUsd: '0.13',
      isClosed: true,
    });
  });

  it('keeps only the opening and closing shares of flip fills', () => {
    const fills = [
      fill(20, false, '3', '1', '7', '0.3'),
      fill(21, true, '5', '-2', '-4', '0.5'),
    ];

    expect(episodeTexts(fills, 20)).toEqual({
      closedPnl: '-4',
      feesUsd: '0.4',
      isClosed: true,
    });
  });

  it('reports an episode the leader still holds as open', () => {
    const fills = [
      fill(30, false, '2', '0', '0', '0.1'),
      fill(31, true, '1', '-2', '-1.5', '0.05'),
    ];

    expect(episodeTexts(fills, 30)).toEqual({
      closedPnl: '-1.5',
      feesUsd: '0.15',
      isClosed: false,
    });
  });

  it('ends the episode before a fill whose start shows a close that no stored fill made', () => {
    const fills = [
      fill(40, true, '1', '0', '0', '0.05'),
      fill(41, false, '0.4', '1', '2', '0.02'),
      fill(43, false, '1', '0', '0', '0.05'),
    ];

    expect(episodeTexts(fills, 40)).toEqual({
      closedPnl: '2',
      feesUsd: '0.07',
      isClosed: true,
    });
  });

  it('gives no episode when the opening fill is missing', () => {
    expect(episodeTexts([fill(50, true, '1', '0', '0', '0.05')], 49)).toBe(
      null,
    );
  });
});
