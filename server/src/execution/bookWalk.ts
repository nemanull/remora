import { Decimal } from 'decimal.js';

export type BookLevel = {
  price: Decimal;
  size: Decimal;
};

export type BookWalk = {
  filledSize: Decimal;
  averagePrice: Decimal | null;
};

export function walkBook(
  levels: BookLevel[],
  isBuy: boolean,
  size: Decimal,
  limitPx: Decimal,
): BookWalk {
  let remaining = size;
  let filledSize = new Decimal(0);
  let notional = new Decimal(0);
  for (const level of levels) {
    if (remaining.lte(0)) {
      break;
    }
    const isBeyondLimit = isBuy
      ? level.price.gt(limitPx)
      : level.price.lt(limitPx);
    if (isBeyondLimit) {
      break;
    }
    const taken = Decimal.min(remaining, level.size);
    filledSize = filledSize.plus(taken);
    notional = notional.plus(taken.mul(level.price));
    remaining = remaining.minus(taken);
  }
  return {
    filledSize,
    averagePrice: filledSize.isZero() ? null : notional.div(filledSize),
  };
}
