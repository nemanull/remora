import type {
  CollectorStats,
  CollectorWalletStats,
  HyperliquidSocketStats,
  WeightBudget,
} from '@remora/sdk';
import type { IntervalHistogram } from 'node:perf_hooks';

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export type CollectorStatsInput = {
  socket: HyperliquidSocketStats;
  clockOffsetMs: number | null;
  eventLoopDelay: IntervalHistogram;
  budget: Pick<WeightBudget, 'readUsedLastMinute'>;
  wallets: CollectorWalletStats[];
};

export function buildCollectorStats(
  input: CollectorStatsInput,
): CollectorStats {
  const { eventLoopDelay } = input;
  const eventLoopDelayP99Ms =
    eventLoopDelay.count > 0
      ? eventLoopDelay.percentile(99) / NANOSECONDS_PER_MILLISECOND
      : null;
  eventLoopDelay.reset();
  return {
    upstreamState: input.socket.state,
    upstreamConnectedAt: input.socket.connectedAt,
    upstreamReconnects: input.socket.reconnects,
    pingRoundTripMs: input.socket.pingRoundTripMs,
    clockOffsetMs: input.clockOffsetMs,
    eventLoopDelayP99Ms,
    rssBytes: process.memoryUsage().rss,
    weightUsedLastMinute: input.budget.readUsedLastMinute(),
    wallets: input.wallets,
  };
}
