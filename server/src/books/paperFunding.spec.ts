import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { fundingPayment } from './paperFunding';

describe('fundingPayment', () => {
  it.each([
    ['a long pays a positive rate', '0.5', '0.0000125', '-0.40625'],
    ['a short receives a positive rate', '-0.5', '0.0000125', '0.40625'],
    ['a long receives a negative rate', '0.5', '-0.00002', '0.65'],
    ['a short pays a negative rate', '-0.5', '-0.00002', '-0.65'],
    ['a copy without size pays nothing', '0', '0.0000125', '0'],
  ])('charges funding when %s', (_name, size, rate, expected) => {
    const payment = fundingPayment({
      size: new Decimal(size),
      oraclePrice: new Decimal(65_000),
      fundingRate: new Decimal(rate),
    });

    expect(payment.toFixed()).toBe(expected);
  });
});
