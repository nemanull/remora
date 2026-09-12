import { describe, expect, it } from 'vitest';
import { BookChains } from './bookChains';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('BookChains', () => {
  it('runs the tasks of one book in the order they were queued', async () => {
    const chains = new BookChains();
    const order: string[] = [];
    const gate = deferred();
    const first = chains.run('MAIN', '0xaaa', async () => {
      await gate.promise;
      order.push('first');
    });
    const second = chains.run('MAIN', '0xbbb', () => {
      order.push('second');
      return Promise.resolve();
    });
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('runs the shadow ledgers of two leaders independently', async () => {
    const chains = new BookChains();
    const order: string[] = [];
    const gate = deferred();
    const blocked = chains.run('SHADOW', '0xaaa', async () => {
      await gate.promise;
      order.push('blocked leader');
    });
    await chains.run('SHADOW', '0xbbb', () => {
      order.push('other leader');
      return Promise.resolve();
    });
    gate.resolve();
    await blocked;
    expect(order).toEqual(['other leader', 'blocked leader']);
  });

  it('serializes the main book across leaders', async () => {
    const chains = new BookChains();
    const order: string[] = [];
    const gate = deferred();
    const blocked = chains.run('MAIN', '0xaaa', async () => {
      await gate.promise;
      order.push('first leader');
    });
    const next = chains.run('MAIN', '0xbbb', () => {
      order.push('second leader');
      return Promise.resolve();
    });
    gate.resolve();
    await Promise.all([blocked, next]);
    expect(order).toEqual(['first leader', 'second leader']);
  });

  it('keeps the chain going after a task fails', async () => {
    const chains = new BookChains();
    const failed = chains.run('MAIN', '0xaaa', () =>
      Promise.reject(new Error('exchange down')),
    );
    const next = chains.run('MAIN', '0xaaa', () => Promise.resolve('ran'));
    await expect(failed).rejects.toThrow('exchange down');
    await expect(next).resolves.toBe('ran');
  });

  it('drains every queued task, including tasks queued while draining', async () => {
    const chains = new BookChains();
    const ran: string[] = [];
    void chains.run('MAIN', '0xaaa', () => {
      void chains.run('SHADOW', '0xbbb', () => {
        ran.push('queued while draining');
        return Promise.resolve();
      });
      ran.push('first');
      return Promise.resolve();
    });
    await chains.drain();
    expect(ran).toEqual(['first', 'queued while draining']);
  });
});
