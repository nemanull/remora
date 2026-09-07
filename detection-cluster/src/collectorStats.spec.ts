import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { buildCollectorStats } from './collectorStats';

describe('buildCollectorStats', () => {
  it('reports the upstream, the clock offset, the budget and every wallet', () => {
    const histogram = monitorEventLoopDelay();
    const stats = buildCollectorStats({
      socket: {
        state: 'open',
        connectedAt: 1_780_000_000_000,
        reconnects: 3,
        pingRoundTripMs: 98,
      },
      clockOffsetMs: -4,
      eventLoopDelay: histogram,
      budget: { readUsedLastMinute: () => 160 },
      wallets: [
        {
          address: '0xc5fdde670e647823dbf07a09c452fe3f33df8677',
          subscribedAt: 1_780_000_000_100,
          lastEventAt: null,
          backfill: 'truncated',
        },
      ],
    });
    expect(stats).toMatchObject({
      upstreamState: 'open',
      upstreamConnectedAt: 1_780_000_000_000,
      upstreamReconnects: 3,
      pingRoundTripMs: 98,
      clockOffsetMs: -4,
      eventLoopDelayP99Ms: null,
      weightUsedLastMinute: 160,
      wallets: [{ backfill: 'truncated' }],
    });
    expect(stats.rssBytes).toBeGreaterThan(0);
  });

  it('reports the p99 event-loop delay in milliseconds and starts a new window', async () => {
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    await new Promise((resolve) => setTimeout(resolve, 60));
    histogram.disable();
    const input = {
      socket: {
        state: 'open' as const,
        connectedAt: null,
        reconnects: 0,
        pingRoundTripMs: null,
      },
      clockOffsetMs: null,
      eventLoopDelay: histogram,
      budget: { readUsedLastMinute: () => 0 },
      wallets: [],
    };
    const first = buildCollectorStats(input);
    expect(first.eventLoopDelayP99Ms).toBeGreaterThan(5);
    expect(buildCollectorStats(input).eventLoopDelayP99Ms).toBeNull();
  });
});
