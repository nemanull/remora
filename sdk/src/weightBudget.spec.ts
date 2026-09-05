import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeightBudget } from './weightBudget.js';

function track(promise: Promise<void>): { isDone: () => boolean } {
  let isDone = false;
  void promise.then(() => {
    isDone = true;
  });
  return { isDone: () => isDone };
}

describe('WeightBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-04-01T00:00:00Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets calls through while the balance is positive', async () => {
    const budget = new WeightBudget(600);

    const first = track(budget.take(20));
    const second = track(budget.take(20));
    const third = track(budget.take(20));
    await vi.advanceTimersByTimeAsync(0);

    expect([first.isDone(), second.isDone(), third.isDone()]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('makes the next caller wait until the balance is positive again', async () => {
    const budget = new WeightBudget(600);
    await budget.take(20);
    await budget.take(20);
    await budget.take(20);

    const fourth = track(budget.take(20));
    await vi.advanceTimersByTimeAsync(990);
    expect(fourth.isDone()).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    expect(fourth.isDone()).toBe(true);
  });

  it('lets a charge after the call push the balance below zero', async () => {
    const budget = new WeightBudget(600);
    await budget.take(20);
    budget.charge(100);

    const next = track(budget.take(2));
    await vi.advanceTimersByTimeAsync(6_990);
    expect(next.isDone()).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    expect(next.isDone()).toBe(true);
  });

  it('holds at most five seconds of budget after a long idle period', async () => {
    const budget = new WeightBudget(600);
    await budget.take(60);
    await vi.advanceTimersByTimeAsync(600_000);

    await budget.take(20);
    await budget.take(20);
    await budget.take(20);
    const fourth = track(budget.take(20));
    await vi.advanceTimersByTimeAsync(0);

    expect(fourth.isDone()).toBe(false);
  });

  it('pauses every caller for the given time', async () => {
    const budget = new WeightBudget(600);
    budget.pauseFor(60_000);

    const call = track(budget.take(2));
    await vi.advanceTimersByTimeAsync(59_990);
    expect(call.isDone()).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    expect(call.isDone()).toBe(true);
  });

  it('serves waiting callers in the order they asked', async () => {
    const budget = new WeightBudget(600);
    budget.charge(200);
    const order: string[] = [];

    const calls = ['first', 'second', 'third'].map((name) =>
      budget.take(20).then(() => order.push(name)),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('reports the weight used in the last minute and in total', async () => {
    const budget = new WeightBudget(600);
    await budget.take(20);
    budget.charge(5);

    expect(budget.readUsedLastMinute()).toBe(25);

    await vi.advanceTimersByTimeAsync(60_001);
    expect(budget.readUsedLastMinute()).toBe(0);
    expect(budget.readUsedTotal()).toBe(25);
  });
});
