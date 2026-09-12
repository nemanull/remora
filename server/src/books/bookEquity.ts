import { Decimal } from 'decimal.js';

const DAY_MS = 86_400_000;

export type CopyCashFlows = {
  realizedPnl: Decimal;
  feesUsd: Decimal;
  fundingUsd: Decimal;
};

export type MarkedCopy = {
  coin: string;
  size: Decimal;
  entryPx: Decimal | null;
  mark: Decimal | null;
  leverage: number;
};

export type MarkedBook = {
  unrealizedPnl: Decimal;
  grossExposureUsd: Decimal;
  initialMarginUsd: Decimal;
};

export function startOfUtcDay(time: Date): Date {
  return new Date(Math.floor(time.getTime() / DAY_MS) * DAY_MS);
}

export function measureNetPnl(flows: CopyCashFlows): Decimal {
  return flows.realizedPnl.minus(flows.feesUsd).plus(flows.fundingUsd);
}

export function measureUnrealizedPnl(copy: MarkedCopy): Decimal {
  if (copy.entryPx === null || copy.mark === null) {
    return new Decimal(0);
  }
  return copy.size.mul(copy.mark.minus(copy.entryPx));
}

export function measureNotionalUsd(copy: MarkedCopy): Decimal {
  const price = copy.mark ?? copy.entryPx;
  return price === null ? new Decimal(0) : copy.size.abs().mul(price);
}

export function markBook(copies: MarkedCopy[]): MarkedBook {
  let unrealizedPnl = new Decimal(0);
  let grossExposureUsd = new Decimal(0);
  let initialMarginUsd = new Decimal(0);
  for (const copy of copies) {
    const notionalUsd = measureNotionalUsd(copy);
    unrealizedPnl = unrealizedPnl.plus(measureUnrealizedPnl(copy));
    grossExposureUsd = grossExposureUsd.plus(notionalUsd);
    initialMarginUsd = initialMarginUsd.plus(notionalUsd.div(copy.leverage));
  }
  return { unrealizedPnl, grossExposureUsd, initialMarginUsd };
}

export function measureCumulativePnl(input: {
  netPnlUsd: Decimal;
  unrealizedPnl: Decimal;
}): Decimal {
  return input.netPnlUsd.plus(input.unrealizedPnl);
}

export function measurePaperEquity(input: {
  startingEquityUsd: Decimal;
  netPnlUsd: Decimal;
  unrealizedPnl: Decimal;
}): Decimal {
  return input.startingEquityUsd
    .plus(input.netPnlUsd)
    .plus(input.unrealizedPnl);
}
