import type { CopyGapResponse } from '@remora/sdk';
import { formatDateTime, formatUsd, toneOf } from '../format';
import { TableScroll } from './Panel';

type GapPart = Exclude<
  keyof CopyGapResponse,
  | 'positionId'
  | 'book'
  | 'coin'
  | 'closedAt'
  | 'isLeaderEpisodeClosed'
  | 'copyPnl'
  | 'scaledLeaderPnl'
  | 'totalGap'
>;

const PARTS: { key: GapPart; label: string; description: string }[] = [
  {
    key: 'entryDrift',
    label: 'Entry drift',
    description: 'our entry fills against the leader’s VWAP',
  },
  {
    key: 'exitDrift',
    label: 'Exit drift',
    description: 'our exit, stop and reconciliation fills',
  },
  {
    key: 'feeDifference',
    label: 'Fee difference',
    description: 'k times the leader’s fees minus ours',
  },
  {
    key: 'funding',
    label: 'Funding',
    description: 'funding the copy paid or received',
  },
  {
    key: 'residual',
    label: 'Residual',
    description: 'rounding, deferred deltas and skipped signals',
  },
];

type Step = {
  label: string;
  description: string;
  value: number;
  from: number;
  to: number;
  isTotal: boolean;
};

function sumOf(gaps: CopyGapResponse[], key: keyof CopyGapResponse): number {
  return gaps.reduce((total, gap) => total + Number(gap[key]), 0);
}

function buildSteps(gaps: CopyGapResponse[]): Step[] {
  const leader = sumOf(gaps, 'scaledLeaderPnl');
  const steps: Step[] = [
    {
      label: 'Leader × k',
      description: 'the leader’s episode PnL net of fees, scaled by k',
      value: leader,
      from: 0,
      to: leader,
      isTotal: true,
    },
  ];
  let running = leader;
  for (const part of PARTS) {
    const value = sumOf(gaps, part.key);
    steps.push({
      label: part.label,
      description: part.description,
      value,
      from: running,
      to: running + value,
      isTotal: false,
    });
    running += value;
  }
  const copy = sumOf(gaps, 'copyPnl');
  steps.push({
    label: 'Our PnL',
    description: 'realized PnL after fees and funding',
    value: copy,
    from: 0,
    to: copy,
    isTotal: true,
  });
  return steps;
}

function Waterfall({ steps }: { steps: Step[] }) {
  const edges = steps.flatMap((step) => [step.from, step.to]);
  const low = Math.min(0, ...edges);
  const high = Math.max(0, ...edges);
  const span = high - low || 1;
  const toPercent = (value: number) => ((value - low) / span) * 100;
  return (
    <div className="space-y-1.5">
      {steps.map((step) => {
        const start = toPercent(Math.min(step.from, step.to));
        const width = Math.max(
          toPercent(Math.max(step.from, step.to)) - start,
          0.4,
        );
        const fill = step.isTotal
          ? 'bg-ink-3/55'
          : step.value >= 0
            ? 'bg-up'
            : 'bg-down';
        return (
          <div
            key={step.label}
            className="grid grid-cols-[7.5rem_1fr_6rem] items-center gap-3 text-xs sm:grid-cols-[9rem_1fr_7rem]"
            title={step.description}
          >
            <span
              className={step.isTotal ? 'font-medium text-ink' : 'text-ink-2'}
            >
              {step.label}
            </span>
            <div className="relative h-4 rounded-sm bg-raised/60">
              <div
                className="absolute inset-y-0 w-px bg-line-strong"
                style={{ left: `${toPercent(0)}%` }}
              />
              <div
                className={`absolute inset-y-0.5 rounded-sm ${fill}`}
                style={{ left: `${start}%`, width: `${width}%` }}
              />
            </div>
            <span
              className={`text-right tabular-nums ${step.isTotal ? 'font-medium' : ''} ${toneOf(step.value, 4)}`}
            >
              {formatUsd(step.value, { signed: true, isPrecise: true })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function CopyGap({ gaps }: { gaps: CopyGapResponse[] }) {
  const totalGap = sumOf(gaps, 'totalGap');
  const hasOpenEpisodes = gaps.some((gap) => !gap.isLeaderEpisodeClosed);
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <p className="text-xs text-ink-3">
          Over the last {gaps.length} closed{' '}
          {gaps.length === 1 ? 'copy' : 'copies'} the copy trailed the leader by{' '}
          <span className={`font-medium tabular-nums ${toneOf(totalGap, 4)}`}>
            {formatUsd(totalGap, { signed: true, isPrecise: true })}
          </span>
          . Each part below adds up to that gap.
        </p>
        <Waterfall steps={buildSteps(gaps)} />
      </div>
      <div className="-mx-4 -mb-4 border-t border-line">
        <TableScroll>
          <table className="data-table">
            <thead>
              <tr>
                <th>Closed (UTC)</th>
                <th>Coin</th>
                <th>Book</th>
                <th className="numeric">Leader × k</th>
                <th className="numeric">Our PnL</th>
                <th className="numeric">Gap</th>
                {PARTS.map((part) => (
                  <th key={part.key} className="numeric">
                    {part.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {gaps.map((gap) => (
                <tr key={gap.positionId}>
                  <td className="text-ink-2">
                    {formatDateTime(gap.closedAt)}
                    {!gap.isLeaderEpisodeClosed && (
                      <span
                        className="ml-1 text-warn"
                        title="The leader still holds this episode, so its PnL is partial"
                      >
                        *
                      </span>
                    )}
                  </td>
                  <td className="font-medium text-ink">{gap.coin}</td>
                  <td className="text-ink-3">{gap.book.toLowerCase()}</td>
                  <td className={`numeric ${toneOf(gap.scaledLeaderPnl, 4)}`}>
                    {formatUsd(gap.scaledLeaderPnl, {
                      signed: true,
                      isPrecise: true,
                    })}
                  </td>
                  <td className={`numeric ${toneOf(gap.copyPnl, 4)}`}>
                    {formatUsd(gap.copyPnl, { signed: true, isPrecise: true })}
                  </td>
                  <td
                    className={`numeric font-medium ${toneOf(gap.totalGap, 4)}`}
                  >
                    {formatUsd(gap.totalGap, { signed: true, isPrecise: true })}
                  </td>
                  {PARTS.map((part) => (
                    <td
                      key={part.key}
                      className={`numeric ${toneOf(gap[part.key], 4)}`}
                    >
                      {formatUsd(gap[part.key], {
                        signed: true,
                        isPrecise: true,
                      })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        {hasOpenEpisodes && (
          <p className="border-t border-line px-4 py-2 text-[11px] text-ink-3">
            <span className="text-warn">*</span> The leader still holds that
            episode, so its side of the gap counts only what it has closed.
          </p>
        )}
      </div>
    </div>
  );
}
