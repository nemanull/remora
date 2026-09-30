import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type { InvariantResult } from './invariants';
import { REPOSITORY_ROOT } from './labImages';
import type { DecisionCount, LatencyRow, SampleSummary } from './measurements';

export type ReportTable = {
  columns: string[];
  rows: (string | number | null)[][];
};

export type ReportSection = {
  title: string;
  lines?: string[];
  table?: ReportTable;
};

export type ScaleLabReport = {
  scenario: string;
  title: string;
  purpose: string;
  startedAt: Date;
  finishedAt: Date;
  settings: [string, string | number][];
  invariants: InvariantResult[];
  sections: ReportSection[];
};

function formatCell(value: string | number | null): string {
  if (value === null) {
    return 'n/a';
  }
  return typeof value === 'number' ? value.toLocaleString('en-US') : value;
}

function renderTable(table: ReportTable): string[] {
  return [
    `| ${table.columns.join(' | ')} |`,
    `|${table.columns.map(() => '---').join('|')}|`,
    ...table.rows.map((row) => `| ${row.map(formatCell).join(' | ')} |`),
  ];
}

function readCommit(): string {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
    }).trim();
    const changes = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
    }).trim();
    return changes.length > 0 ? `${commit} with uncommitted changes` : commit;
  } catch {
    return 'unknown';
  }
}

function formatMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function latencyTable(rows: LatencyRow[]): ReportTable {
  return {
    columns: [
      'Step',
      'Samples',
      'p50 ms (simulated)',
      'p90 ms (simulated)',
      'p99 ms (simulated)',
      'max ms (simulated)',
    ],
    rows: rows.map((row) => [
      row.step,
      row.count,
      row.p50,
      row.p90,
      row.p99,
      row.max,
    ]),
  };
}

export function decisionTable(counts: DecisionCount[]): ReportTable {
  return {
    columns: ['Book', 'Verdict', 'Reason', 'Decisions (simulated)'],
    rows: counts.map((count) => [
      count.book,
      count.verdict,
      count.reason,
      count.count,
    ]),
  };
}

export function sampleRow(
  name: string,
  summary: SampleSummary,
): (string | number | null)[] {
  return [name, summary.samples, summary.median, summary.max];
}

export const SAMPLE_COLUMNS = [
  'Measure',
  'Samples',
  'median (simulated)',
  'max (simulated)',
];

export function writeReport(report: ScaleLabReport): string {
  const date = report.finishedAt.toISOString().slice(0, 10);
  const directory = join(REPOSITORY_ROOT, 'reports');
  const path = join(directory, `scale-lab-${report.scenario}-${date}.md`);
  const passed = report.invariants.every((invariant) => invariant.passed);
  const lines = [
    `# Scale lab: ${report.title}`,
    '',
    'Every number in this report is simulated.',
    'It comes from the remora images running against hyperliquid-sim on one Docker host, not from Hyperliquid.',
    '',
    `- Scenario: ${report.purpose}`,
    `- Run: ${formatMinute(report.startedAt)} to ${formatMinute(report.finishedAt)}`,
    `- Commit: ${readCommit()}`,
    `- Host: ${cpus().length} cores, ${Math.round(totalmem() / 1024 ** 3)} GB, Linux ${release()}`,
    `- Result: ${passed ? 'every invariant held' : 'at least one invariant failed'}`,
    '',
    '## Settings',
    '',
    ...renderTable({
      columns: ['Setting', 'Value'],
      rows: report.settings.map(([name, value]) => [name, String(value)]),
    }),
    '',
    '## Invariants',
    '',
    ...renderTable({
      columns: ['Invariant', 'Result', 'Checked (simulated)'],
      rows: report.invariants.map((invariant) => [
        invariant.name,
        invariant.passed ? 'held' : 'failed',
        invariant.summary,
      ]),
    }),
  ];
  for (const invariant of report.invariants) {
    if (invariant.violations.length > 0) {
      lines.push(
        '',
        `Violations of "${invariant.name}":`,
        '',
        ...invariant.violations.map((violation) => `- ${violation}`),
      );
    }
  }
  for (const section of report.sections) {
    lines.push('', `## ${section.title}`, '');
    if (section.lines) {
      lines.push(...section.lines);
    }
    if (section.lines && section.table) {
      lines.push('');
    }
    if (section.table) {
      lines.push(...renderTable(section.table));
    }
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}
