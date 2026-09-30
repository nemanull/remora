import type { Pool } from 'pg';
import type { Lab } from './labEnvironment';

const MINUTE_MS = 60_000;
const SERVER_WEIGHT_SERIES =
  'remora_hyperliquid_weight_used_total{process="server"}';

export type LatencyRow = {
  step: string;
  count: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
};

export type DecisionCount = {
  book: string;
  verdict: string;
  reason: string;
  count: number;
};

export type SampleSummary = {
  samples: number;
  median: number | null;
  max: number | null;
};

const LATENCY_STEPS: { step: string; sql: string }[] = [
  {
    step: 'leader fill to collector receive',
    sql: `SELECT extract(epoch FROM received_at - time) * 1000 AS value
            FROM "LeaderFill" WHERE source = 'STREAM' AND received_at >= $1`,
  },
  {
    step: 'collector receive to core store',
    sql: `SELECT extract(epoch FROM ingested_at - received_at) * 1000 AS value
            FROM "LeaderFill" WHERE source = 'STREAM' AND received_at >= $1`,
  },
  {
    step: 'collector receive to decision',
    sql: `SELECT extract(epoch FROM decided_at - received_at) * 1000 AS value
            FROM "CopyDecision" WHERE signal_source = 'stream' AND decided_at >= $1`,
  },
  {
    step: 'leader fill to decision',
    sql: `SELECT extract(epoch FROM decided_at - leader_time) * 1000 AS value
            FROM "CopyDecision" WHERE signal_source = 'stream' AND decided_at >= $1`,
  },
  {
    step: 'decision to order submit',
    sql: `SELECT extract(epoch FROM orders.submitted_at - decision.decided_at) * 1000 AS value
            FROM "Order" orders JOIN "CopyDecision" decision ON decision.id = orders.decision_id
           WHERE decision.signal_source = 'stream' AND decision.decided_at >= $1`,
  },
  {
    step: 'order submit to acknowledgement',
    sql: `SELECT extract(epoch FROM orders.acknowledged_at - orders.submitted_at) * 1000 AS value
            FROM "Order" orders JOIN "CopyDecision" decision ON decision.id = orders.decision_id
           WHERE decision.signal_source = 'stream' AND decision.decided_at >= $1
             AND orders.acknowledged_at IS NOT NULL`,
  },
  {
    step: 'leader fill to acknowledgement',
    sql: `SELECT extract(epoch FROM orders.acknowledged_at - decision.leader_time) * 1000 AS value
            FROM "Order" orders JOIN "CopyDecision" decision ON decision.id = orders.decision_id
           WHERE decision.signal_source = 'stream' AND decision.decided_at >= $1
             AND orders.acknowledged_at IS NOT NULL`,
  },
];

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

export async function measureLatency(
  database: Pool,
  since: Date,
): Promise<LatencyRow[]> {
  const rows: LatencyRow[] = [];
  for (const { step, sql } of LATENCY_STEPS) {
    const { rows: summary } = await database.query<{
      count: string;
      p50: number | null;
      p90: number | null;
      p99: number | null;
      max: number | null;
    }>(
      `SELECT count(*)::text AS count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY value)::float8 AS p50,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY value)::float8 AS p90,
              percentile_cont(0.99) WITHIN GROUP (ORDER BY value)::float8 AS p99,
              max(value)::float8 AS max
         FROM (${sql}) latencies`,
      [since],
    );
    const [row] = summary;
    rows.push({
      step,
      count: Number(row.count),
      p50: round(row.p50),
      p90: round(row.p90),
      p99: round(row.p99),
      max: round(row.max),
    });
  }
  return rows;
}

export async function countDecisions(
  database: Pool,
  since: Date,
): Promise<DecisionCount[]> {
  const { rows } = await database.query<{
    book: string;
    verdict: string;
    reason: string;
    count: string;
  }>(
    `SELECT book::text AS book, verdict::text AS verdict, reason, count(*)::text AS count
       FROM "CopyDecision" WHERE decided_at >= $1
      GROUP BY book, verdict, reason
      ORDER BY book, verdict, count(*) DESC, reason`,
    [since],
  );
  return rows.map((row) => ({ ...row, count: Number(row.count) }));
}

export async function countActivity(
  database: Pool,
  since: Date,
): Promise<Record<string, number>> {
  const { rows } = await database.query<{ name: string; count: string }>(
    `SELECT name, count FROM (
       SELECT 1 AS position, 'stored fills' AS name, count(*)::text AS count FROM "LeaderFill" WHERE ingested_at >= $1
       UNION ALL SELECT 2, 'stream fills', count(*)::text FROM "LeaderFill" WHERE ingested_at >= $1 AND source = 'STREAM'
       UNION ALL SELECT 3, 'backfilled fills', count(*)::text FROM "LeaderFill" WHERE ingested_at >= $1 AND source = 'BACKFILL'
       UNION ALL SELECT 4, 'decisions', count(*)::text FROM "CopyDecision" WHERE decided_at >= $1
       UNION ALL SELECT 5, 'catch-up decisions', count(*)::text FROM "CopyDecision" WHERE decided_at >= $1 AND signal_source = 'catch_up'
       UNION ALL SELECT 6, 'orders', count(*)::text FROM "Order" WHERE submitted_at >= $1
       UNION ALL SELECT 7, 'filled orders', count(*)::text FROM "Order" WHERE submitted_at >= $1 AND status = 'FILLED'
       UNION ALL SELECT 8, 'copies opened', count(*)::text FROM "CopyPosition" WHERE opened_at >= $1
       UNION ALL SELECT 9, 'copies closed', count(*)::text FROM "CopyPosition" WHERE closed_at >= $1
     ) counts ORDER BY position`,
    [since],
  );
  return Object.fromEntries(rows.map((row) => [row.name, Number(row.count)]));
}

export function summarizeSamples(samples: number[]): SampleSummary {
  if (samples.length === 0) {
    return { samples: 0, median: null, max: null };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    samples: sorted.length,
    median: round(median),
    max: round(sorted[sorted.length - 1]),
  };
}

export function readPrometheusValue(text: string, name: string): number | null {
  for (const line of text.split('\n')) {
    if (line.startsWith(`${name} `)) {
      const value = Number(
        line
          .slice(name.length + 1)
          .trim()
          .split(' ')[0],
      );
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

export type CounterSample = { at: number; total: number };

export function measurePerMinute(samples: CounterSample[]): number[] {
  const rates: number[] = [];
  let start = 0;
  for (const sample of samples) {
    while (
      start < samples.length - 1 &&
      sample.at - samples[start + 1].at >= MINUTE_MS
    ) {
      start += 1;
    }
    const first = samples[start];
    const span = sample.at - first.at;
    const spent = sample.total - first.total;
    if (span >= MINUTE_MS && spent >= 0) {
      rates.push((spent / span) * MINUTE_MS);
    }
  }
  return rates;
}

export class LoadSampler {
  private readonly serverWeightTotals: CounterSample[] = [];
  private readonly serverEventLoopMs: number[] = [];
  private readonly collectorEventLoopMs: number[] = [];
  private readonly newConnectionsPerMinute: number[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly lab: Lab,
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
  }

  stop(): {
    serverEventLoopP99Ms: SampleSummary;
    serverWeightPerMinute: SampleSummary;
    collectorEventLoopP99Ms: SampleSummary;
    newConnectionsPerMinutePerAddress: SampleSummary;
  } {
    clearInterval(this.timer);
    return {
      serverEventLoopP99Ms: summarizeSamples(this.serverEventLoopMs),
      serverWeightPerMinute: summarizeSamples(
        measurePerMinute(this.serverWeightTotals),
      ),
      collectorEventLoopP99Ms: summarizeSamples(this.collectorEventLoopMs),
      newConnectionsPerMinutePerAddress: summarizeSamples(
        this.newConnectionsPerMinute,
      ),
    };
  }

  private async sample(): Promise<void> {
    await Promise.allSettled([
      this.sampleServer(),
      this.sampleCollectors(),
      this.sampleConnections(),
    ]);
  }

  private async sampleServer(): Promise<void> {
    const response = await fetch(`${this.lab.serverUrl}/metrics`, {
      signal: AbortSignal.timeout(5_000),
    });
    const exposition = await response.text();
    const eventLoopLag = readPrometheusValue(
      exposition,
      'nodejs_eventloop_lag_p99_seconds',
    );
    if (eventLoopLag !== null) {
      this.serverEventLoopMs.push(eventLoopLag * 1_000);
    }
    const weight = readPrometheusValue(exposition, SERVER_WEIGHT_SERIES);
    if (weight !== null) {
      this.serverWeightTotals.push({ at: Date.now(), total: weight });
    }
  }

  private async sampleCollectors(): Promise<void> {
    const { clusters } = await this.lab.readClusters();
    for (const cluster of clusters) {
      const delay = cluster.isOnline
        ? (cluster.stats?.eventLoopDelayP99Ms ?? null)
        : null;
      if (delay !== null) {
        this.collectorEventLoopMs.push(delay);
      }
    }
  }

  private async sampleConnections(): Promise<void> {
    const connections = await this.lab.readConnections();
    const peak = Math.max(
      0,
      ...connections.addresses.map(
        (address) => address.newConnectionsLastMinute,
      ),
    );
    this.newConnectionsPerMinute.push(peak);
  }
}
