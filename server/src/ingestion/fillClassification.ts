import { Decimal } from 'decimal.js';

export type ClassifiedFill = {
  tid: bigint;
  price: Decimal;
  size: Decimal;
  isBuy: boolean;
  startPosition: Decimal;
  time: Date;
};

export type FillSummary = {
  positionBefore: Decimal;
  positionAfter: Decimal;
  touchedZero: boolean;
  episodeOpenTid: bigint | null;
  vwap: Decimal;
  lastTime: Date;
};

type VolumeWeightedPrice = {
  notional: Decimal;
  size: Decimal;
};

type Segment = {
  traded: VolumeWeightedPrice;
  closing: VolumeWeightedPrice;
};

const EMPTY_VOLUME: VolumeWeightedPrice = {
  notional: new Decimal(0),
  size: new Decimal(0),
};

const EMPTY_SEGMENT: Segment = { traded: EMPTY_VOLUME, closing: EMPTY_VOLUME };

export function isMainDexPerp(
  coin: string,
  markets: ReadonlyMap<string, unknown>,
): boolean {
  return (
    !coin.includes(':') &&
    !coin.startsWith('@') &&
    !coin.startsWith('#') &&
    markets.has(coin)
  );
}

export function positionAfter(fill: ClassifiedFill): Decimal {
  return fill.isBuy
    ? fill.startPosition.plus(fill.size)
    : fill.startPosition.minus(fill.size);
}

function isOppositeSide(first: Decimal, second: Decimal): boolean {
  return (
    !first.isZero() && !second.isZero() && first.isNeg() !== second.isNeg()
  );
}

function addVolume(
  volume: VolumeWeightedPrice,
  price: Decimal,
  size: Decimal,
): VolumeWeightedPrice {
  return {
    notional: volume.notional.plus(price.times(size)),
    size: volume.size.plus(size),
  };
}

function addToSegment(
  segment: Segment,
  price: Decimal,
  size: Decimal,
  isClosing: boolean,
): Segment {
  return {
    traded: addVolume(segment.traded, price, size),
    closing: isClosing
      ? addVolume(segment.closing, price, size)
      : segment.closing,
  };
}

function readVwap(volume: VolumeWeightedPrice, fallback: Decimal): Decimal {
  return volume.size.isZero()
    ? fallback
    : volume.notional.dividedBy(volume.size);
}

export function summarizeFills(fills: readonly ClassifiedFill[]): FillSummary {
  const first = fills[0];
  const last = fills[fills.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('Cannot summarize an empty list of fills');
  }
  let touchedZero = false;
  let episodeOpenTid: bigint | null = null;
  let segment = EMPTY_SEGMENT;
  let lastClosing = EMPTY_VOLUME;
  let previousAfter: Decimal | null = null;

  for (const fill of fills) {
    const before = fill.startPosition;
    const after = positionAfter(fill);
    if (previousAfter !== null && !previousAfter.eq(before)) {
      const closedUnseen =
        !previousAfter.isZero() &&
        (before.isZero() || isOppositeSide(previousAfter, before));
      if (closedUnseen) {
        touchedZero = true;
        segment = EMPTY_SEGMENT;
      }
      if (closedUnseen || previousAfter.isZero()) {
        episodeOpenTid = before.isZero() ? null : fill.tid;
      }
    }
    if (before.isZero()) {
      if (!after.isZero()) {
        episodeOpenTid = fill.tid;
        segment = addToSegment(segment, fill.price, fill.size, false);
      }
    } else if (after.isZero()) {
      segment = addToSegment(segment, fill.price, fill.size, true);
      touchedZero = true;
      lastClosing = segment.closing;
      segment = EMPTY_SEGMENT;
      episodeOpenTid = null;
    } else if (isOppositeSide(before, after)) {
      segment = addToSegment(segment, fill.price, before.abs(), true);
      touchedZero = true;
      lastClosing = segment.closing;
      segment = addToSegment(EMPTY_SEGMENT, fill.price, after.abs(), false);
      episodeOpenTid = fill.tid;
    } else {
      const isClosing = after.abs().lt(before.abs());
      segment = addToSegment(segment, fill.price, fill.size, isClosing);
    }
    previousAfter = after;
  }

  const positionAfterLast = positionAfter(last);
  const isFlat = positionAfterLast.isZero();
  return {
    positionBefore: first.startPosition,
    positionAfter: positionAfterLast,
    touchedZero,
    episodeOpenTid: isFlat ? null : episodeOpenTid,
    vwap: readVwap(isFlat ? lastClosing : segment.traded, last.price),
    lastTime: last.time,
  };
}
