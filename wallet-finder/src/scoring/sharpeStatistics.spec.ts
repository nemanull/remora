import { describe, expect, it } from 'vitest';
import {
  computeDeflatedBenchmark,
  computeExpectedMaximumSharpe,
  computePositiveShare,
  computeProbabilisticSharpe,
  computeSortino,
  describeReturns,
  normalCdf,
  normalQuantile,
} from './sharpeStatistics';

const SYMMETRIC_RETURNS = [0.02, -0.01, 0.03, 0, 0.01, -0.02, 0.04, 0.01];
const SKEWED_RETURNS = [0.05, -0.01, 0, 0.01, -0.02, 0, 0.02, -0.01, 0.01, 0];

describe('normal distribution', () => {
  it.each([
    [-3, 0.0013498980316301035],
    [-1.5, 0.06680720126885809],
    [0, 0.5],
    [0.5, 0.6914624612740131],
    [2.5, 0.9937903346742238],
  ])('gives the cumulative probability at %d', (x, expected) => {
    expect(normalCdf(x)).toBeCloseTo(expected, 6);
  });

  it.each([
    [0.001, -3.090232306167813],
    [0.01, -2.3263478740408408],
    [0.3, -0.5244005127080407],
    [0.5, 0],
    [0.975, 1.9599639845400536],
    [0.999, 3.090232306167813],
  ])('inverts the cumulative probability %d', (probability, expected) => {
    expect(normalQuantile(probability)).toBeCloseTo(expected, 7);
  });
});

describe('describeReturns', () => {
  it('measures the per-period Sharpe with the sample deviation and raw moments', () => {
    const moments = describeReturns(SKEWED_RETURNS);

    expect(moments?.periods).toBe(10);
    expect(moments?.mean).toBeCloseTo(0.005, 12);
    expect(moments?.sharpe).toBeCloseTo(0.25537695922762454, 10);
    expect(moments?.skewness).toBeCloseTo(1.1235796216866065, 10);
    expect(moments?.kurtosis).toBeCloseTo(3.903591682419661, 10);
  });

  it('gives nothing for a single return or a flat series', () => {
    expect(describeReturns([0.01])).toBeNull();
    expect(describeReturns([0.01, 0.01, 0.01])).toBeNull();
  });
});

describe('computeProbabilisticSharpe', () => {
  it('matches the hand-computed PSR of a symmetric series', () => {
    const moments = describeReturns(SYMMETRIC_RETURNS);

    expect(moments?.sharpe).toBeCloseTo(0.5, 12);
    expect(computeProbabilisticSharpe(moments!)).toBeCloseTo(
      0.9003201429429744,
      6,
    );
    expect(computeProbabilisticSharpe(moments!, 0.1)).toBeCloseTo(
      0.8477196709530196,
      6,
    );
  });

  it('matches the hand-computed PSR of a positively skewed series', () => {
    const moments = describeReturns(SKEWED_RETURNS);

    expect(computeProbabilisticSharpe(moments!)).toBeCloseTo(
      0.8101850515340239,
      6,
    );
  });

  it('uses the number of periods present, so fewer periods mean less confidence', () => {
    const weekly = describeReturns([
      ...SYMMETRIC_RETURNS,
      ...SYMMETRIC_RETURNS,
    ]);
    const biweekly = describeReturns(SYMMETRIC_RETURNS);

    expect(computeProbabilisticSharpe(biweekly!)).toBeLessThan(
      computeProbabilisticSharpe(weekly!)!,
    );
  });
});

describe('computeExpectedMaximumSharpe', () => {
  it('reproduces the expected best annualised Sharpe of zero-skill wallets', () => {
    const dailyVariance = 1 / 30;

    expect(
      computeExpectedMaximumSharpe(dailyVariance, 1_376) * Math.sqrt(365),
    ).toBeCloseTo(11.67, 2);
    expect(
      computeExpectedMaximumSharpe(dailyVariance, 100) * Math.sqrt(365),
    ).toBeCloseTo(8.83, 2);
    expect(
      computeExpectedMaximumSharpe(1 / 26, 1_376) * Math.sqrt(52),
    ).toBeCloseTo(4.73, 2);
  });

  it('derives the deflated benchmark from the spread of the cohort Sharpes', () => {
    const sharpes = [0.1, 0.3, -0.2, 0.5, 0.0];
    const mean = 0.14;
    const variance =
      sharpes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / 4;

    expect(computeDeflatedBenchmark(sharpes)).toBeCloseTo(
      computeExpectedMaximumSharpe(variance, 5),
      12,
    );
    expect(computeDeflatedBenchmark([0.4])).toBeNull();
  });
});

describe('computeSortino', () => {
  it('divides the mean by the downside deviation over every period', () => {
    expect(computeSortino(SYMMETRIC_RETURNS)).toBeCloseTo(
      1.2649110640673518,
      10,
    );
  });

  it('gives nothing when no period lost money', () => {
    expect(computeSortino([0.01, 0.02, 0])).toBeNull();
  });
});

describe('computePositiveShare', () => {
  it('counts only periods strictly above zero', () => {
    expect(computePositiveShare(SYMMETRIC_RETURNS)).toBe(5 / 8);
    expect(computePositiveShare([])).toBeNull();
  });
});
