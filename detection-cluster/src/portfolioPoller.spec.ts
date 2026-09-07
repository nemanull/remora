import type { PortfolioResponse } from '@remora/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortfolioPoller } from './portfolioPoller';

const INTERVAL_MS = 600_000;
const WALLETS = [
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002',
  '0x0000000000000000000000000000000000000003',
  '0x0000000000000000000000000000000000000004',
];
const PORTFOLIO: PortfolioResponse = [
  ['day', { accountValueHistory: [], pnlHistory: [], vlm: '0.0' }],
];

describe('PortfolioPoller', () => {
  let polls: { wallet: string; at: number }[];
  let delivered: string[];
  let poller: PortfolioPoller;
  let failure: Error | null;

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_780_000_000_000);
    polls = [];
    delivered = [];
    failure = null;
    poller = new PortfolioPoller({
      infoClient: {
        portfolio: (wallet: string) => {
          polls.push({ wallet, at: Date.now() });
          return failure ? Promise.reject(failure) : Promise.resolve(PORTFOLIO);
        },
      },
      intervalMs: INTERVAL_MS,
      onPortfolio: (wallet) => delivered.push(wallet),
      onError: (wallet) => delivered.push(`error:${wallet}`),
    });
  });

  afterEach(() => {
    poller.stop();
    vi.useRealTimers();
  });

  it('polls new wallets at once and then each wallet once per interval, staggered', async () => {
    poller.setWallets(WALLETS);
    await advance(0);
    expect(polls.map((poll) => poll.wallet)).toEqual(WALLETS);
    polls = [];
    await advance(3 * INTERVAL_MS);
    for (const wallet of WALLETS) {
      const times = polls
        .filter((poll) => poll.wallet === wallet)
        .map((poll) => poll.at);
      expect(times.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index] - times[index - 1]).toBe(INTERVAL_MS);
      }
    }
    const lastCycle = polls.slice(-4).map((poll) => poll.at);
    for (let index = 1; index < lastCycle.length; index += 1) {
      expect(lastCycle[index] - lastCycle[index - 1]).toBe(INTERVAL_MS / 4);
    }
  });

  it('never leaves a wallet unpolled for longer than one and a half intervals', async () => {
    poller.setWallets(WALLETS);
    await advance(4 * INTERVAL_MS);
    for (const wallet of WALLETS) {
      const times = [
        1_780_000_000_000,
        ...polls
          .filter((poll) => poll.wallet === wallet)
          .map((poll) => poll.at),
      ];
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index] - times[index - 1]).toBeLessThanOrEqual(
          1.5 * INTERVAL_MS,
        );
      }
    }
  });

  it('stops polling a removed wallet and drops its late answer', async () => {
    poller.setWallets(WALLETS);
    poller.setWallets(WALLETS.slice(1));
    await advance(2 * INTERVAL_MS);
    expect(delivered).not.toContain(WALLETS[0]);
    expect(polls.filter((poll) => poll.wallet === WALLETS[0])).toHaveLength(1);
  });

  it('keeps its rotation when an assign leaves the wallet set unchanged', async () => {
    poller.setWallets(WALLETS);
    await advance(0);
    polls = [];
    for (let step = 0; step < 8; step += 1) {
      await advance(INTERVAL_MS / 8);
      poller.setWallets([...WALLETS]);
    }
    expect(polls.length).toBeGreaterThanOrEqual(2);
  });

  it('reports failed polls and keeps polling', async () => {
    failure = new Error('status 500');
    poller.setWallets(WALLETS.slice(0, 1));
    await advance(0);
    failure = null;
    await advance(INTERVAL_MS);
    expect(delivered).toEqual([`error:${WALLETS[0]}`, WALLETS[0]]);
  });

  it('stops every poll when stopped', async () => {
    poller.setWallets(WALLETS);
    await advance(0);
    poller.stop();
    polls = [];
    await advance(2 * INTERVAL_MS);
    expect(polls).toEqual([]);
  });
});
