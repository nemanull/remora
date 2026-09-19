import type { Decimal } from 'decimal.js';

export function fundingPayment(input: {
  size: Decimal;
  oraclePrice: Decimal;
  fundingRate: Decimal;
}): Decimal {
  return input.size.mul(input.oraclePrice).mul(input.fundingRate).neg();
}
