const MAX_PERP_DECIMALS = 6;
const SIGNIFICANT_FIGURES = 5;
const INTEGER_PRICE_FLOOR = 100_000;

export function toWireDecimal(value: number, maxDecimals: number): string {
  const fixed = value.toFixed(maxDecimals);
  const trimmed = fixed.includes('.')
    ? fixed.replace(/0+$/, '').replace(/\.$/, '.0')
    : `${fixed}.0`;
  return trimmed === '-0.0' ? '0.0' : trimmed;
}

export function roundPrice(price: number, szDecimals: number): number {
  if (price >= INTEGER_PRICE_FLOOR) {
    return Math.round(price);
  }
  const significant = Number(price.toPrecision(SIGNIFICANT_FIGURES));
  return Number(significant.toFixed(MAX_PERP_DECIMALS - szDecimals));
}

export function formatPrice(price: number, szDecimals: number): string {
  return toWireDecimal(
    roundPrice(price, szDecimals),
    MAX_PERP_DECIMALS - szDecimals,
  );
}

export function formatLots(lots: number, szDecimals: number): string {
  return toWireDecimal(lots / 10 ** szDecimals, szDecimals);
}

export function formatUsd(value: number): string {
  return toWireDecimal(value, 6);
}
