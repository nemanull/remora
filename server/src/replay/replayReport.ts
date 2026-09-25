import { Decimal } from 'decimal.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measureNetPnl, measureUnrealizedPnl } from '../books/bookEquity';
import {
  type CopyGap,
  splitCopyGap,
  summarizeLeaderEpisode,
} from '../books/copyGap';
import { MEDIAN_SWEEP_BPS } from './replayExecutor';
import type { ReplayCopy, ReplayInput, ReplayOutcome } from './replayRun';

const LABEL = 'replay';

type GapParts = Omit<CopyGap, 'copyPnl' | 'scaledLeaderPnl'>;

export type ReplayCopyResult = {
  coin: string;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  copyPnlUsd: string;
  scaledLeaderPnlUsd: string | null;
};

export type ReplayReport = {
  label: typeof LABEL;
  wallet: string;
  window: { start: string; end: string };
  generatedAt: string;
  parameters: {
    allocationUsd: string;
    latencyMs: number;
    driftBps: number;
    sweepBps: number;
    takerFeeBps: number;
  };
  data: {
    source: string;
    fills: number;
    isTruncated: boolean;
    coins: string[];
    candles: number;
    fundingItems: number;
    equityPoints: number;
  };
  signals: number;
  decisions: number;
  copies: { opened: number; closed: number; openAtEnd: number };
  closedCopies: {
    matchedEpisodes: number;
    copyPnlUsd: string;
    scaledLeaderPnlUsd: string;
    copyReturn: number;
    leaderReturn: number;
    captureRatio: number | null;
    gap: Record<keyof GapParts, string>;
  };
  openCopiesUnrealizedUsd: string;
  reasons: { verdict: string; reason: string; count: number }[];
  copyResults: ReplayCopyResult[];
};

function usd(value: Decimal): string {
  return value.toFixed(2);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function roundGap(gap: GapParts): Record<keyof GapParts, string> {
  const rounded = {
    totalGap: gap.totalGap.toDecimalPlaces(2),
    entryDrift: gap.entryDrift.toDecimalPlaces(2),
    exitDrift: gap.exitDrift.toDecimalPlaces(2),
    feeDifference: gap.feeDifference.toDecimalPlaces(2),
    funding: gap.funding.toDecimalPlaces(2),
  };
  const residual = rounded.totalGap
    .minus(rounded.entryDrift)
    .minus(rounded.exitDrift)
    .minus(rounded.feeDifference)
    .minus(rounded.funding);
  return {
    totalGap: usd(rounded.totalGap),
    entryDrift: usd(rounded.entryDrift),
    exitDrift: usd(rounded.exitDrift),
    feeDifference: usd(rounded.feeDifference),
    funding: usd(rounded.funding),
    residual: usd(residual),
  };
}

function readEpisode(input: ReplayInput, copy: ReplayCopy) {
  const fills = input.fills
    .filter((fill) => fill.coin === copy.coin)
    .map((fill) => ({
      tid: BigInt(fill.tid),
      isBuy: fill.side === 'B',
      size: new Decimal(fill.sz),
      startPosition: new Decimal(fill.startPosition),
      closedPnl: new Decimal(fill.closedPnl),
      fee: new Decimal(fill.fee),
    }));
  return summarizeLeaderEpisode(fills, copy.leaderOpenTid);
}

function countReasons(outcome: ReplayOutcome): ReplayReport['reasons'] {
  const counts = new Map<string, number>();
  for (const decision of outcome.decisions) {
    const key = `${decision.verdict} ${decision.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => {
      const [verdict, reason] = key.split(' ');
      return { verdict, reason, count };
    })
    .sort((left, right) => right.count - left.count);
}

export function buildReplayReport(
  input: ReplayInput,
  outcome: ReplayOutcome,
  isTruncated: boolean,
  generatedAt: Date,
): ReplayReport {
  const allocationUsd = input.settings.shadowAllocationUsd;
  const zero = new Decimal(0);
  const gap: GapParts = {
    totalGap: zero,
    entryDrift: zero,
    exitDrift: zero,
    feeDifference: zero,
    funding: zero,
    residual: zero,
  };
  let copyPnl = zero;
  let scaledLeaderPnl = zero;
  let matchedEpisodes = 0;
  const copyResults: ReplayCopyResult[] = [];
  for (const copy of outcome.copies) {
    const episode = copy.isOpen ? null : readEpisode(input, copy);
    const copyGap =
      episode === null
        ? null
        : splitCopyGap({
            ratio: copy.ratio,
            realizedPnl: copy.realizedPnl,
            feesUsd: copy.feesUsd,
            fundingUsd: copy.fundingUsd,
            leaderClosedPnl: episode.closedPnl,
            leaderFeesUsd: episode.feesUsd,
            orders: copy.orders,
          });
    if (copyGap !== null) {
      matchedEpisodes += 1;
      copyPnl = copyPnl.plus(copyGap.copyPnl);
      scaledLeaderPnl = scaledLeaderPnl.plus(copyGap.scaledLeaderPnl);
      for (const part of Object.keys(gap) as (keyof GapParts)[]) {
        gap[part] = gap[part].plus(copyGap[part]);
      }
    }
    copyResults.push({
      coin: copy.coin,
      openedAt: copy.openedAt.toISOString(),
      closedAt: copy.closedAt?.toISOString() ?? null,
      closeReason: copy.closeReason,
      copyPnlUsd: usd(measureNetPnl(copy)),
      scaledLeaderPnlUsd:
        copyGap === null ? null : usd(copyGap.scaledLeaderPnl),
    });
  }
  const unrealized = outcome.copies
    .filter((copy) => copy.isOpen)
    .reduce(
      (total, copy) =>
        total.plus(
          measureUnrealizedPnl({
            coin: copy.coin,
            size: copy.size,
            entryPx: copy.entryPx,
            mark: outcome.marks.get(copy.coin) ?? null,
            leverage: 1,
          }),
        ),
      zero,
    );
  return {
    label: LABEL,
    wallet: input.wallet,
    window: { start: input.start.toISOString(), end: input.end.toISOString() },
    generatedAt: generatedAt.toISOString(),
    parameters: {
      allocationUsd: usd(allocationUsd),
      latencyMs: input.latencyMs,
      driftBps: input.driftBps,
      sweepBps: MEDIAN_SWEEP_BPS,
      takerFeeBps: input.takerFeeBps,
    },
    data: {
      source: input.source,
      fills: input.fills.length,
      isTruncated,
      coins: [...input.candles.keys()],
      candles: [...input.candles.values()].reduce(
        (total, candles) => total + candles.length,
        0,
      ),
      fundingItems: [...input.funding.values()].reduce(
        (total, items) => total + items.length,
        0,
      ),
      equityPoints: input.equity.length,
    },
    signals: outcome.signals,
    decisions: outcome.decisions.length,
    copies: {
      opened: outcome.copies.length,
      closed: outcome.copies.filter((copy) => !copy.isOpen).length,
      openAtEnd: outcome.copies.filter((copy) => copy.isOpen).length,
    },
    closedCopies: {
      matchedEpisodes,
      copyPnlUsd: usd(copyPnl),
      scaledLeaderPnlUsd: usd(scaledLeaderPnl),
      copyReturn: copyPnl.div(allocationUsd).toNumber(),
      leaderReturn: scaledLeaderPnl.div(allocationUsd).toNumber(),
      captureRatio: scaledLeaderPnl.isZero()
        ? null
        : copyPnl.div(scaledLeaderPnl).toNumber(),
      gap: roundGap(gap),
    },
    openCopiesUnrealizedUsd: usd(unrealized),
    reasons: countReasons(outcome),
    copyResults,
  };
}

export function renderReplayMarkdown(report: ReplayReport): string {
  const window = `${report.window.start.slice(0, 10)} to ${report.window.end.slice(0, 10)}`;
  const label = `${LABEL}, ${window}`;
  const closed = report.closedCopies;
  const row = (cells: (string | number)[]): string =>
    `| ${cells.join(' | ')} |`;
  const lines = [
    `# Replay of ${report.wallet}, ${window}`,
    '',
    `Every number below is a replay number for the window ${report.window.start} to ${report.window.end}.`,
    "It comes from the leader's historical fills run through the live decision engine, with 15-minute candles for marks and stops and realized funding.",
    'None of it is a paper or a live result.',
    '',
    '## Parameters',
    '',
    row(['Parameter', 'Value']),
    row(['---', '---']),
    row(['Allocation per leader', `${report.parameters.allocationUsd} USD`]),
    row([
      'Latency from leader fill to decision',
      `${report.parameters.latencyMs} ms`,
    ]),
    row([
      'Mid drift at decision, against the copy',
      `${report.parameters.driftBps} bps`,
    ]),
    row(['Sweep cost per fill', `${report.parameters.sweepBps} bps`]),
    row(['Taker fee', `${report.parameters.takerFeeBps} bps`]),
    '',
    '## Data',
    '',
    row(['Item', 'Value']),
    row(['---', '---']),
    row(['Info endpoint', report.data.source]),
    row(['Main-dex fills read', report.data.fills]),
    row([
      'Cut at the 10,000-fill horizon',
      report.data.isTruncated ? 'yes' : 'no',
    ]),
    row(['Coins', report.data.coins.join(', ') || 'none']),
    row(['15-minute candles', report.data.candles]),
    row(['Funding records', report.data.fundingItems]),
    row(['Leader equity points', report.data.equityPoints]),
    '',
    '## Results',
    '',
    row(['Metric', 'Value', 'Label']),
    row(['---', '---', '---']),
    row(['Signals', report.signals, label]),
    row(['Stored decisions', report.decisions, label]),
    row(['Copies opened', report.copies.opened, label]),
    row(['Copies closed', report.copies.closed, label]),
    row(['Copies open at the end', report.copies.openAtEnd, label]),
    row([
      'Closed copies matched to a leader episode',
      closed.matchedEpisodes,
      label,
    ]),
    row(['Copy PnL after fees and funding', `${closed.copyPnlUsd} USD`, label]),
    row([
      'Leader PnL over the same episodes, scaled by k',
      `${closed.scaledLeaderPnlUsd} USD`,
      label,
    ]),
    row(['Copy return on the allocation', percent(closed.copyReturn), label]),
    row([
      'Leader return over the same trades',
      percent(closed.leaderReturn),
      label,
    ]),
    row([
      'Capture ratio',
      closed.captureRatio === null ? 'n/a' : closed.captureRatio.toFixed(3),
      label,
    ]),
    row([
      'Unrealized PnL of copies open at the end',
      `${report.openCopiesUnrealizedUsd} USD`,
      label,
    ]),
    '',
    '## Copy gap of closed copies',
    '',
    row(['Part', 'USD', 'Label']),
    row(['---', '---', '---']),
    row(['Entry drift', closed.gap.entryDrift, label]),
    row(['Exit drift', closed.gap.exitDrift, label]),
    row(['Fee difference', closed.gap.feeDifference, label]),
    row(['Funding', closed.gap.funding, label]),
    row([
      'Residual from rounding, deferral and skipped signals',
      closed.gap.residual,
      label,
    ]),
    row(['Total gap', closed.gap.totalGap, label]),
    '',
    '## Decisions by reason',
    '',
    row(['Verdict', 'Reason', 'Count', 'Label']),
    row(['---', '---', '---', '---']),
    ...report.reasons.map((entry) =>
      row([entry.verdict, entry.reason, entry.count, label]),
    ),
    '',
  ];
  return lines.join('\n');
}

export async function writeReplayReport(
  report: ReplayReport,
  directory: string,
): Promise<{ markdown: string; json: string }> {
  await mkdir(directory, { recursive: true });
  const name = `replay-${report.wallet}-${report.window.end.slice(0, 10)}`;
  const markdown = join(directory, `${name}.md`);
  const json = join(directory, `${name}.json`);
  await writeFile(markdown, renderReplayMarkdown(report));
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
  return { markdown, json };
}
