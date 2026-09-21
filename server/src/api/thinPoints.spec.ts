import { describe, expect, it } from 'vitest';
import { thinPoints } from './thinPoints';

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

describe('thinPoints', () => {
  it('keeps a series that already fits', () => {
    expect(thinPoints(range(5), 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps every nth point, the first and the latest', () => {
    expect(thinPoints(range(10), 4)).toEqual([0, 3, 6, 9]);
    expect(thinPoints(range(11), 4)).toEqual([0, 3, 6, 9, 10]);
  });
});
