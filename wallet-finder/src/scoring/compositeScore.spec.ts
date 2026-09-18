import { describe, expect, it } from 'vitest';
import {
  type ComponentValues,
  computePercentileRank,
  computeQuantile,
  FINAL_COMPONENTS,
  PRELIMINARY_COMPONENTS,
  rankCohort,
} from './compositeScore';

function values(level: number): ComponentValues {
  return {
    significance: 0.8 + level / 100,
    drawdown: -0.5 + level / 10,
    edge: 25 + level * 10,
    recency: level / 5,
    consistency: 0.4 + level / 20,
    copyability: Math.log(60 + level * 100),
  };
}

describe('computeQuantile', () => {
  it('interpolates linearly between the closest ranks', () => {
    expect(computeQuantile([1, 2, 3, 4, 5], 0.05)).toBeCloseTo(1.2, 12);
    expect(computeQuantile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 12);
    expect(computeQuantile([7], 0.95)).toBe(7);
  });
});

describe('computePercentileRank', () => {
  it('splits ties evenly between the ranks they share', () => {
    expect(computePercentileRank([1, 2, 2, 3], 2)).toBe(0.5);
    expect(computePercentileRank([1, 2, 2, 3], 3)).toBe(0.875);
  });
});

describe('rankCohort', () => {
  const cohort = new Map(
    ['0xa', '0xb', '0xc', '0xd', '0xe'].map((address, level) => [
      address,
      values(level),
    ]),
  );

  it('ranks each component and weights the percentiles into the composite', () => {
    const ranked = rankCohort(cohort, FINAL_COMPONENTS);

    expect(ranked.get('0xe')?.composite).toBeCloseTo(0.9, 12);
    expect(ranked.get('0xc')?.composite).toBeCloseTo(0.5, 12);
    expect(ranked.get('0xa')?.composite).toBeCloseTo(0.1, 12);
  });

  it('records the raw, winsorized and percentile values with each contribution', () => {
    const significance = rankCohort(cohort, FINAL_COMPONENTS)
      .get('0xe')
      ?.components.find((component) => component.name === 'significance');

    expect(significance?.raw).toBeCloseTo(0.84, 12);
    expect(significance?.winsorized).toBeCloseTo(0.83 + 0.8 * 0.01, 12);
    expect(significance?.percentile).toBeCloseTo(0.9, 12);
    expect(significance?.weight).toBe(0.3);
    expect(significance?.contribution).toBeCloseTo(0.27, 12);
  });

  it('scales the five preliminary weights to sum to one', () => {
    const components = rankCohort(cohort, PRELIMINARY_COMPONENTS).get(
      '0xa',
    )?.components;

    expect(components?.map((component) => component.name)).toEqual(
      PRELIMINARY_COMPONENTS,
    );
    expect(
      components?.reduce((sum, component) => sum + component.weight, 0),
    ).toBeCloseTo(1, 12);
    expect(components?.[0].weight).toBeCloseTo(1 / 3, 12);
  });

  it('clips outliers at the 5th and 95th percentile so the extremes tie', () => {
    const wide = new Map(
      Array.from({ length: 100 }, (_, index) => [
        `0x${index}`,
        { ...values(0), edge: index + 1 },
      ]),
    );

    const ranked = rankCohort(wide, ['edge']);
    const lowest = ranked.get('0x0')?.components[0];
    const fifth = ranked.get('0x4')?.components[0];

    expect(lowest?.winsorized).toBeCloseTo(5.95, 12);
    expect(fifth?.winsorized).toBeCloseTo(5.95, 12);
    expect(lowest?.percentile).toBe(fifth?.percentile);
    expect(lowest?.percentile).toBeCloseTo(0.025, 12);
  });

  it('gives a missing metric no percentile and no contribution', () => {
    const withGap = new Map(cohort);
    withGap.set('0xf', { ...values(4), recency: null });

    const recency = rankCohort(withGap, FINAL_COMPONENTS)
      .get('0xf')
      ?.components.find((component) => component.name === 'recency');

    expect(recency).toEqual({
      name: 'recency',
      raw: null,
      winsorized: null,
      percentile: null,
      weight: 0.15,
      contribution: 0,
    });
  });

  it('puts a lone passer at the middle of its cohort', () => {
    const ranked = rankCohort(new Map([['0xa', values(2)]]), FINAL_COMPONENTS);

    expect(ranked.get('0xa')?.composite).toBeCloseTo(0.5, 12);
  });
});
