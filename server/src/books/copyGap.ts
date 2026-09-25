import { Decimal } from 'decimal.js';
import type { OrderPurpose } from '../copy/types';

export type GapOrder = {
  purpose: OrderPurpose;
  isBuy: boolean;
  filledSize: Decimal;
  averagePrice: Decimal | null;
  referencePrice: Decimal;
};

export type CopyGap = {
  copyPnl: Decimal;
  scaledLeaderPnl: Decimal;
  totalGap: Decimal;
  entryDrift: Decimal;
  exitDrift: Decimal;
  feeDifference: Decimal;
  funding: Decimal;
  residual: Decimal;
};

function priceDrift(orders: GapOrder[]): Decimal {
  return orders.reduce((total, order) => {
    if (order.averagePrice === null || order.filledSize.isZero()) {
      return total;
    }
    const edge = order.isBuy
      ? order.referencePrice.minus(order.averagePrice)
      : order.averagePrice.minus(order.referencePrice);
    return total.plus(edge.mul(order.filledSize));
  }, new Decimal(0));
}

export function splitCopyGap(input: {
  ratio: Decimal;
  realizedPnl: Decimal;
  feesUsd: Decimal;
  fundingUsd: Decimal;
  leaderClosedPnl: Decimal;
  leaderFeesUsd: Decimal;
  orders: GapOrder[];
}): CopyGap {
  const copyPnl = input.realizedPnl.minus(input.feesUsd).plus(input.fundingUsd);
  const scaledLeaderPnl = input.ratio.mul(
    input.leaderClosedPnl.minus(input.leaderFeesUsd),
  );
  const totalGap = copyPnl.minus(scaledLeaderPnl);
  const entryDrift = priceDrift(
    input.orders.filter((order) => order.purpose === 'ENTRY'),
  );
  const exitDrift = priceDrift(
    input.orders.filter((order) => order.purpose !== 'ENTRY'),
  );
  const feeDifference = input.ratio
    .mul(input.leaderFeesUsd)
    .minus(input.feesUsd);
  const funding = input.fundingUsd;
  const residual = totalGap
    .minus(entryDrift)
    .minus(exitDrift)
    .minus(feeDifference)
    .minus(funding);
  return {
    copyPnl,
    scaledLeaderPnl,
    totalGap,
    entryDrift,
    exitDrift,
    feeDifference,
    funding,
    residual,
  };
}

export type EpisodeFill = {
  tid: bigint;
  isBuy: boolean;
  size: Decimal;
  startPosition: Decimal;
  closedPnl: Decimal;
  fee: Decimal;
};

export type LeaderEpisode = {
  closedPnl: Decimal;
  feesUsd: Decimal;
  isClosed: boolean;
};

function shareOf(part: Decimal, whole: Decimal): Decimal {
  return whole.isZero() ? new Decimal(0) : Decimal.min(part.div(whole), 1);
}

export function summarizeLeaderEpisode(
  fills: EpisodeFill[],
  openTid: bigint,
): LeaderEpisode | null {
  const openIndex = fills.findIndex((fill) => fill.tid === openTid);
  if (openIndex === -1) {
    return null;
  }
  const opening = fills[openIndex];
  const openedPosition = opening.startPosition.plus(
    opening.isBuy ? opening.size : opening.size.neg(),
  );
  const side = openedPosition.isNeg() ? -1 : 1;
  const isFlip =
    !opening.startPosition.isZero() &&
    opening.startPosition.isNeg() !== openedPosition.isNeg();
  let closedPnl = isFlip ? new Decimal(0) : opening.closedPnl;
  let feesUsd = isFlip
    ? opening.fee.mul(shareOf(openedPosition.abs(), opening.size))
    : opening.fee;
  for (const fill of fills.slice(openIndex + 1)) {
    if (fill.startPosition.mul(side).lte(0)) {
      return { closedPnl, feesUsd, isClosed: true };
    }
    const after = fill.startPosition.plus(
      fill.isBuy ? fill.size : fill.size.neg(),
    );
    closedPnl = closedPnl.plus(fill.closedPnl);
    if (after.mul(side).lte(0)) {
      feesUsd = feesUsd.plus(
        fill.fee.mul(shareOf(fill.startPosition.abs(), fill.size)),
      );
      return { closedPnl, feesUsd, isClosed: true };
    }
    feesUsd = feesUsd.plus(fill.fee);
  }
  return { closedPnl, feesUsd, isClosed: false };
}
