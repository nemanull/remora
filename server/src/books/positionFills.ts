import { Decimal } from 'decimal.js';

export type PositionLedger = {
  size: Decimal;
  entryPx: Decimal | null;
  realizedPnl: Decimal;
};

export type PositionFill = {
  isBuy: boolean;
  size: Decimal;
  price: Decimal;
};

function signed(size: Decimal, isBuy: boolean): Decimal {
  return isBuy ? size : size.neg();
}

export function applyFill(
  ledger: PositionLedger,
  fill: PositionFill,
): PositionLedger {
  if (fill.size.lte(0)) {
    return ledger;
  }
  const isIncrease =
    ledger.size.isZero() || ledger.size.isPositive() === fill.isBuy;
  if (isIncrease) {
    const size = ledger.size.plus(signed(fill.size, fill.isBuy));
    const heldCost =
      ledger.entryPx === null
        ? new Decimal(0)
        : ledger.size.abs().mul(ledger.entryPx);
    return {
      size,
      entryPx: heldCost.plus(fill.size.mul(fill.price)).div(size.abs()),
      realizedPnl: ledger.realizedPnl,
    };
  }
  const reduced = Decimal.min(fill.size, ledger.size.abs());
  const entryPx = ledger.entryPx ?? fill.price;
  const direction = ledger.size.isPositive() ? 1 : -1;
  const realizedPnl = ledger.realizedPnl.plus(
    reduced.mul(fill.price.minus(entryPx)).mul(direction),
  );
  const flipped = fill.size.minus(reduced);
  if (flipped.isZero()) {
    return {
      size: ledger.size.plus(signed(reduced, fill.isBuy)),
      entryPx: ledger.entryPx,
      realizedPnl,
    };
  }
  return {
    size: signed(flipped, fill.isBuy),
    entryPx: fill.price,
    realizedPnl,
  };
}
