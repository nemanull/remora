import { describe, expect, it } from 'vitest';
import { computeMaxDrawdown } from './drawdown';

describe('computeMaxDrawdown', () => {
  it('measures the deepest fall of the compounded curve from its running peak', () => {
    expect(computeMaxDrawdown([0.1, -0.2, 0.05, -0.1, 0.3])).toBeCloseTo(
      0.8316 / 1.1 - 1,
      12,
    );
  });

  it('measures a fall from the starting equity before any peak', () => {
    expect(computeMaxDrawdown([-0.1, -0.1, 0.5])).toBeCloseTo(-0.19, 12);
  });

  it('reports zero for a curve that never falls and nothing for no returns', () => {
    expect(computeMaxDrawdown([0.01, 0, 0.02])).toBe(0);
    expect(computeMaxDrawdown([])).toBeNull();
  });
});
