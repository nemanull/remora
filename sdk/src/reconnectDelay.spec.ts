import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconnectDelayMs } from './reconnectDelay.js';

describe('reconnectDelayMs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never waits less than 2 s', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(reconnectDelayMs(0)).toBe(2_000);
  });

  it('waits between 2 s and 4 s on the first attempt', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999_999);

    expect(reconnectDelayMs(0)).toBeCloseTo(4_000, 0);
  });

  it('doubles the ceiling with every attempt', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect([0, 1, 2].map(reconnectDelayMs)).toEqual([2_000, 4_000, 8_000]);
  });

  it('caps the delay at 30 s with a floor of 15 s once the cap is reached', () => {
    const random = vi.spyOn(Math, 'random');

    random.mockReturnValue(0);
    expect(reconnectDelayMs(12)).toBe(15_000);
    random.mockReturnValue(0.999_999);
    expect(reconnectDelayMs(12)).toBeLessThanOrEqual(30_000);
  });

  it('stays between the floor and the cap for real random values', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (let sample = 0; sample < 200; sample += 1) {
        const delay = reconnectDelayMs(attempt);
        expect(delay).toBeGreaterThanOrEqual(2_000);
        expect(delay).toBeLessThanOrEqual(30_000);
      }
    }
  });
});
