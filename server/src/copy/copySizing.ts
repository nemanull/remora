import { Decimal } from 'decimal.js';

export const MIN_ORDER_NOTIONAL_USD = new Decimal(10);
const MAX_SIGNIFICANT_FIGURES = 5;
const MAX_PRICE_DECIMALS = 6;
const INTEGER_PRICE_FROM = new Decimal(100_000);
const RATIO_DECIMALS = 18;
const BASIS_POINTS = 10_000;

export type CapName = 'position' | 'leader' | 'gross' | 'open_copies';

export type EntryCap = {
  name: CapName;
  remainingUsd: Decimal;
};

export type EntrySizing = {
  rawTarget: Decimal;
  target: Decimal;
  bindingCap: EntryCap | null;
  orderSize: Decimal;
  orderNotionalUsd: Decimal;
  result: 'order' | 'below_min_notional' | 'at_target';
};

export type ExitSizing = {
  target: Decimal;
  orderSize: Decimal;
  orderNotionalUsd: Decimal;
  isExactClose: boolean;
  result: 'order' | 'below_min_notional' | 'no_size';
};

export function floorOrderSize(size: Decimal, szDecimals: number): Decimal {
  return size.abs().toDecimalPlaces(szDecimals, Decimal.ROUND_DOWN);
}

export function roundLimitPrice(
  price: Decimal,
  szDecimals: number,
  isBuy: boolean,
): Decimal {
  const rounding = isBuy ? Decimal.ROUND_DOWN : Decimal.ROUND_UP;
  if (price.gte(INTEGER_PRICE_FROM)) {
    return price.toDecimalPlaces(0, rounding);
  }
  return price
    .toSignificantDigits(MAX_SIGNIFICANT_FIGURES, rounding)
    .toDecimalPlaces(Math.max(0, MAX_PRICE_DECIMALS - szDecimals), rounding);
}

export function limitPrice(
  reference: Decimal,
  isBuy: boolean,
  bandBps: number,
  szDecimals: number,
): Decimal {
  const band = new Decimal(bandBps).div(BASIS_POINTS);
  const banded = isBuy
    ? reference.mul(band.plus(1))
    : reference.mul(new Decimal(1).minus(band));
  return roundLimitPrice(banded, szDecimals, isBuy);
}

export function copyRatio(
  allocationUsd: Decimal,
  leaderEquityUsd: Decimal,
): Decimal {
  return allocationUsd
    .div(leaderEquityUsd)
    .toDecimalPlaces(RATIO_DECIMALS, Decimal.ROUND_DOWN);
}

export function reduceTarget(
  copySize: Decimal,
  leaderSize: Decimal,
  leaderSizeAtSync: Decimal,
): Decimal {
  return copySize.mul(leaderSize.abs()).div(leaderSizeAtSync.abs());
}

function findBindingCap(
  notionalUsd: Decimal,
  caps: EntryCap[],
): EntryCap | null {
  let tightest: EntryCap | null = null;
  for (const cap of caps) {
    if (tightest === null || cap.remainingUsd.lt(tightest.remainingUsd)) {
      tightest = cap;
    }
  }
  if (tightest === null || notionalUsd.lte(tightest.remainingUsd)) {
    return null;
  }
  return tightest;
}

export function sizeEntry(input: {
  ratio: Decimal;
  leaderSize: Decimal;
  copySize: Decimal;
  mid: Decimal;
  szDecimals: number;
  caps: EntryCap[];
}): EntrySizing {
  const rawTarget = input.ratio.mul(input.leaderSize);
  const bindingCap = findBindingCap(rawTarget.abs().mul(input.mid), input.caps);
  const target =
    bindingCap === null
      ? rawTarget
      : Decimal.max(bindingCap.remainingUsd, 0)
          .div(input.mid)
          .mul(rawTarget.isNegative() ? -1 : 1);
  const heldSize = input.copySize.abs();
  if (target.abs().lte(heldSize)) {
    return {
      rawTarget,
      target,
      bindingCap,
      orderSize: new Decimal(0),
      orderNotionalUsd: new Decimal(0),
      result: 'at_target',
    };
  }
  const orderSize = floorOrderSize(
    target.abs().minus(heldSize),
    input.szDecimals,
  );
  const orderNotionalUsd = orderSize.mul(input.mid);
  return {
    rawTarget,
    target,
    bindingCap,
    orderSize,
    orderNotionalUsd,
    result: orderNotionalUsd.lt(MIN_ORDER_NOTIONAL_USD)
      ? 'below_min_notional'
      : 'order',
  };
}

export function sizeExit(input: {
  kind: 'close' | 'reduce';
  copySize: Decimal;
  leaderSize: Decimal;
  leaderSizeAtSync: Decimal;
  mid: Decimal;
  szDecimals: number;
}): ExitSizing {
  const isExactClose = input.kind === 'close';
  if (input.copySize.isZero()) {
    return {
      target: new Decimal(0),
      orderSize: new Decimal(0),
      orderNotionalUsd: new Decimal(0),
      isExactClose,
      result: 'no_size',
    };
  }
  if (isExactClose) {
    const orderSize = input.copySize.abs();
    return {
      target: new Decimal(0),
      orderSize,
      orderNotionalUsd: orderSize.mul(input.mid),
      isExactClose,
      result: 'order',
    };
  }
  const target = reduceTarget(
    input.copySize,
    input.leaderSize,
    input.leaderSizeAtSync,
  );
  const orderSize = floorOrderSize(
    input.copySize.abs().minus(target.abs()),
    input.szDecimals,
  );
  const orderNotionalUsd = orderSize.mul(input.mid);
  return {
    target,
    orderSize,
    orderNotionalUsd,
    isExactClose,
    result: orderNotionalUsd.lt(MIN_ORDER_NOTIONAL_USD)
      ? 'below_min_notional'
      : 'order',
  };
}

export function stopPrice(input: {
  size: Decimal;
  entryPx: Decimal;
  allocationUsd: Decimal;
  lossShare: number;
  maxDistance: number;
  szDecimals: number;
}): Decimal | null {
  if (input.size.isZero()) {
    return null;
  }
  const isLong = input.size.isPositive();
  const lossDistance = input.allocationUsd
    .mul(input.lossShare)
    .div(input.size.abs());
  const distance = Decimal.min(
    lossDistance,
    input.entryPx.mul(input.maxDistance),
  );
  const price = isLong
    ? input.entryPx.minus(distance)
    : input.entryPx.plus(distance);
  return roundLimitPrice(price, input.szDecimals, !isLong);
}
