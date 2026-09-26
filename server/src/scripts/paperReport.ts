import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CopyGapResponse } from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CopyGapsService } from '../api/copyGaps.service';
import { PrismaService } from '../prisma/prisma.service';

const GAP_PARTS = [
  'copyPnl',
  'scaledLeaderPnl',
  'totalGap',
  'entryDrift',
  'exitDrift',
  'feeDifference',
  'funding',
  'residual',
] as const;

const LATENCY_STEPS: { step: string; sql: string }[] = [
  {
    step: 'leader fill to collector receive',
    sql: `SELECT extract(epoch FROM received_at - time) * 1000 AS value
            FROM "LeaderFill" WHERE source = 'STREAM' AND received_at BETWEEN $1 AND $2`,
  },
  {
    step: 'collector receive to core store',
    sql: `SELECT extract(epoch FROM ingested_at - received_at) * 1000 AS value
            FROM "LeaderFill" WHERE source = 'STREAM' AND received_at BETWEEN $1 AND $2`,
  },
  {
    step: 'collector receive to decision',
    sql: `SELECT extract(epoch FROM decided_at - received_at) * 1000 AS value
            FROM "CopyDecision" WHERE signal_source = 'stream' AND decided_at BETWEEN $1 AND $2`,
  },
  {
    step: 'decision to order submit',
    sql: `SELECT extract(epoch FROM orders.submitted_at - decision.decided_at) * 1000 AS value
            FROM "Order" orders JOIN "CopyDecision" decision ON decision.id = orders.decision_id
           WHERE decision.signal_source = 'stream' AND decision.decided_at BETWEEN $1 AND $2`,
  },
  {
    step: 'order submit to acknowledgement',
    sql: `SELECT extract(epoch FROM orders.acknowledged_at - orders.submitted_at) * 1000 AS value
            FROM "Order" orders JOIN "CopyDecision" decision ON decision.id = orders.decision_id
           WHERE decision.signal_source = 'stream' AND decision.decided_at BETWEEN $1 AND $2
             AND orders.acknowledged_at IS NOT NULL`,
  },
  {
    step: 'leader fill to acknowledgement',
    sql: `SELECT extract(epoch FROM orders.acknowledged_at - decision.leader_time) * 1000 AS value
            FROM "Order" orders JOIN "CopyDecision" decision ON decision.id = orders.decision_id
           WHERE decision.signal_source = 'stream' AND decision.decided_at BETWEEN $1 AND $2
             AND orders.acknowledged_at IS NOT NULL`,
  },
];

const argumentsSchema = z.object({
  since: z.iso.datetime(),
  until: z.iso.datetime().optional(),
  market: z.enum(['simulator', 'hyperliquid']),
});

export type GapTotals = {
  book: string;
  copies: number;
} & Record<(typeof GAP_PARTS)[number], Decimal>;

export type LatencyRow = {
  step: string;
  samples: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
};

export type PaperReport = {
  label: string;
  market: 'simulator' | 'hyperliquid';
  since: Date;
  until: Date;
  generatedAt: Date;
  activity: [string, number][];
  decisions: { book: string; verdict: string; reason: string; count: number }[];
  latency: LatencyRow[];
  gaps: GapTotals[];
  closedCopies: number;
  scoringRuns: {
    id: string;
    startedAt: Date;
    finishedAt: Date | null;
    leaderboardRows: number | null;
    stageOneCount: number | null;
    stageTwoCount: number | null;
    stageThreeCount: number | null;
    passed: number;
  }[];
  leaders: [string, number][];
};

const logger = new Logger('PaperReport');

function emptyTotals(book: string): GapTotals {
  return {
    book,
    copies: 0,
    copyPnl: new Decimal(0),
    scaledLeaderPnl: new Decimal(0),
    totalGap: new Decimal(0),
    entryDrift: new Decimal(0),
    exitDrift: new Decimal(0),
    feeDifference: new Decimal(0),
    funding: new Decimal(0),
    residual: new Decimal(0),
  };
}

export function sumCopyGaps(gaps: CopyGapResponse[]): GapTotals[] {
  const totals = new Map<string, GapTotals>();
  for (const gap of gaps) {
    const total = totals.get(gap.book) ?? emptyTotals(gap.book);
    total.copies += 1;
    for (const part of GAP_PARTS) {
      total[part] = total[part].plus(gap[part]);
    }
    totals.set(gap.book, total);
  }
  return [...totals.values()].sort((left, right) =>
    left.book.localeCompare(right.book),
  );
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : value.toLocaleString('en-US');
}

function formatUsd(value: Decimal): string {
  const text = value.toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

function formatMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function table(columns: string[], rows: string[][]): string[] {
  return [
    `| ${columns.join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

export function renderPaperReport(report: PaperReport): string {
  const label = report.label;
  const marketLine =
    report.market === 'simulator'
      ? 'The stack ran in paper mode against hyperliquid-sim, so the market, the leaders and their fills are synthetic.'
      : 'The stack ran in paper mode against the Hyperliquid API, so leaders and fills are real and our orders were simulated.';
  return [
    `# Paper run, ${report.since.toISOString().slice(0, 10)}`,
    '',
    `Every number in this report is labelled ${label}.`,
    marketLine,
    '',
    `- Window: ${formatMinute(report.since)} to ${formatMinute(report.until)}`,
    `- Generated: ${formatMinute(report.generatedAt)}`,
    '',
    '## Activity',
    '',
    ...table(
      ['Count', `Value (${label})`],
      report.activity.map(([name, value]) => [name, formatNumber(value)]),
    ),
    '',
    '## Leaders at the end of the window',
    '',
    ...table(
      ['Status', `Wallets (${label})`],
      report.leaders.map(([status, count]) => [status, formatNumber(count)]),
    ),
    '',
    '## Decisions by verdict and reason',
    '',
    ...table(
      ['Book', 'Verdict', 'Reason', `Decisions (${label})`],
      report.decisions.map((row) => [
        row.book,
        row.verdict,
        row.reason,
        formatNumber(row.count),
      ]),
    ),
    '',
    '## Latency of stream signals',
    '',
    'Paper orders are acknowledged after the configured paper latency, so the last two steps show that setting rather than an exchange.',
    '',
    ...table(
      [
        'Step',
        'Samples',
        `p50 ms (${label})`,
        `p90 ms (${label})`,
        `p99 ms (${label})`,
      ],
      report.latency.map((row) => [
        row.step,
        formatNumber(row.samples),
        formatNumber(row.p50),
        formatNumber(row.p90),
        formatNumber(row.p99),
      ]),
    ),
    '',
    '## Copy gap of closed copies',
    '',
    `${report.closedCopies} copies closed in the window, and ${report.gaps.reduce((sum, total) => sum + total.copies, 0)} of them have a measurable leader episode.`,
    'The gap is the copy PnL minus the leader PnL scaled by k, split into entry drift, exit drift, the fee difference, funding and a residual, in USD.',
    '',
    ...table(
      [
        'Book',
        'Copies',
        `copy PnL (${label})`,
        `scaled leader PnL (${label})`,
        `gap (${label})`,
        `entry drift (${label})`,
        `exit drift (${label})`,
        `fee difference (${label})`,
        `funding (${label})`,
        `residual (${label})`,
      ],
      report.gaps.map((total) => [
        total.book,
        String(total.copies),
        ...GAP_PARTS.map((part) => formatUsd(total[part])),
      ]),
    ),
    '',
    '## Scoring runs',
    '',
    ...table(
      [
        'Run',
        'Started',
        'Finished',
        `Leaderboard rows (${label})`,
        `Stage one (${label})`,
        `Stage two (${label})`,
        `Stage three (${label})`,
        `Passed every gate (${label})`,
      ],
      report.scoringRuns.map((run) => [
        run.id,
        formatMinute(run.startedAt),
        run.finishedAt === null ? 'running' : formatMinute(run.finishedAt),
        formatNumber(run.leaderboardRows),
        formatNumber(run.stageOneCount),
        formatNumber(run.stageTwoCount),
        formatNumber(run.stageThreeCount),
        formatNumber(run.passed),
      ]),
    ),
    '',
  ].join('\n');
}

async function readLatency(
  prisma: PrismaService,
  since: Date,
  until: Date,
): Promise<LatencyRow[]> {
  const rows: LatencyRow[] = [];
  for (const { step, sql } of LATENCY_STEPS) {
    const [row] = await prisma.$queryRawUnsafe<
      {
        samples: bigint;
        p50: number | null;
        p90: number | null;
        p99: number | null;
      }[]
    >(
      `SELECT count(*) AS samples,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY value)::numeric, 1)::float8 AS p50,
              round(percentile_cont(0.9) WITHIN GROUP (ORDER BY value)::numeric, 1)::float8 AS p90,
              round(percentile_cont(0.99) WITHIN GROUP (ORDER BY value)::numeric, 1)::float8 AS p99
         FROM (${sql}) latencies`,
      since,
      until,
    );
    rows.push({
      step,
      samples: Number(row.samples),
      p50: row.p50,
      p90: row.p90,
      p99: row.p99,
    });
  }
  return rows;
}

async function readActivity(
  prisma: PrismaService,
  since: Date,
  until: Date,
): Promise<[string, number][]> {
  const window = { gte: since, lte: until };
  const [fills, decisions, orders, opened, closed] = await Promise.all([
    prisma.leaderFill.groupBy({
      by: ['source'],
      where: { ingestedAt: window },
      _count: { _all: true },
    }),
    prisma.copyDecision.count({ where: { decidedAt: window } }),
    prisma.order.groupBy({
      by: ['status'],
      where: { submittedAt: window },
      _count: { _all: true },
    }),
    prisma.copyPosition.count({ where: { openedAt: window } }),
    prisma.copyPosition.count({ where: { closedAt: window } }),
  ]);
  return [
    ...fills.map((row): [string, number] => [
      `${row.source.toLowerCase()} fills stored`,
      row._count._all,
    ]),
    ['decisions', decisions],
    ...orders.map((row): [string, number] => [
      `${row.status.toLowerCase()} orders`,
      row._count._all,
    ]),
    ['copies opened', opened],
    ['copies closed', closed],
  ];
}

async function buildReport(
  prisma: PrismaService,
  options: z.output<typeof argumentsSchema>,
): Promise<PaperReport> {
  const since = new Date(options.since);
  const until =
    options.until === undefined ? new Date() : new Date(options.until);
  const window = { gte: since, lte: until };
  const [decisions, runs, leaders, closed] = await Promise.all([
    prisma.copyDecision.groupBy({
      by: ['book', 'verdict', 'reason'],
      where: { decidedAt: window },
      _count: { _all: true },
    }),
    prisma.scoringRun.findMany({
      where: { startedAt: window },
      orderBy: { startedAt: 'asc' },
    }),
    prisma.wallet.groupBy({ by: ['status'], _count: { _all: true } }),
    new CopyGapsService(prisma).readCopyGapsClosedBetween(since, until),
  ]);
  const passed = await prisma.walletScore.groupBy({
    by: ['runId'],
    where: { runId: { in: runs.map((run) => run.id) }, stage: 3, passed: true },
    _count: { _all: true },
  });
  const passedByRun = new Map(
    passed.map((row) => [row.runId, row._count._all]),
  );
  return {
    label: options.market === 'simulator' ? 'paper, simulated market' : 'paper',
    market: options.market,
    since,
    until,
    generatedAt: new Date(),
    activity: await readActivity(prisma, since, until),
    decisions: decisions
      .map((row) => ({
        book: row.book,
        verdict: row.verdict,
        reason: row.reason,
        count: row._count._all,
      }))
      .sort(
        (left, right) =>
          left.book.localeCompare(right.book) ||
          left.verdict.localeCompare(right.verdict) ||
          right.count - left.count,
      ),
    latency: await readLatency(prisma, since, until),
    gaps: sumCopyGaps(closed.gaps),
    closedCopies: closed.closedCopies,
    scoringRuns: runs.map((run) => ({
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      leaderboardRows: run.leaderboardRows,
      stageOneCount: run.stageOneCount,
      stageTwoCount: run.stageTwoCount,
      stageThreeCount: run.stageThreeCount,
      passed: passedByRun.get(run.id) ?? 0,
    })),
    leaders: leaders.map((row): [string, number] => [
      row.status,
      row._count._all,
    ]),
  };
}

async function writePaperReport(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      market: { type: 'string' },
    },
  });
  const options = argumentsSchema.parse(values);
  const databaseUrl = z.url().parse(process.env.DATABASE_URL);
  const prisma = new PrismaService(
    new ConfigService({ DATABASE_URL: databaseUrl }),
  );
  try {
    const report = await buildReport(prisma, options);
    const directory = join(process.cwd(), 'reports');
    await mkdir(directory, { recursive: true });
    const path = join(
      directory,
      `paper-${options.market}-${report.until.toISOString().slice(0, 10)}.md`,
    );
    await writeFile(path, renderPaperReport(report));
    logger.log(
      `Wrote the paper report for ${options.since} onwards to ${path}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  writePaperReport().catch((error) => {
    logger.error(
      'Paper report failed',
      error instanceof Error ? error.stack : String(error),
    );
    process.exitCode = 1;
  });
}
