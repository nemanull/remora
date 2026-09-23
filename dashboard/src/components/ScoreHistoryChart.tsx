import type { WalletScoreResponse } from '@remora/sdk';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';
import { formatDay, formatScore } from '../format';

type ScorePoint = {
  time: number;
  runId: string;
  score: number | null;
  stage: number;
  passed: boolean;
};

const AXIS_TICK = { fill: 'var(--ink-3)', fontSize: 11 };

function ScoreTooltip({ active, payload }: TooltipContentProps) {
  const point = payload?.[0]?.payload as ScorePoint | undefined;
  if (!active || point === undefined) {
    return null;
  }
  return (
    <div className="rounded-md border border-line-strong bg-panel px-3 py-2 text-xs shadow-lg shadow-black/20">
      <p className="text-sm font-semibold text-ink tabular-nums">
        {formatScore(point.score)}
      </p>
      <p className="mt-0.5 font-mono text-[11px] text-ink-3">{point.runId}</p>
      <p className="mt-1 text-ink-2">
        Stage {point.stage}, {point.passed ? 'passed' : 'failed a gate'}
      </p>
    </div>
  );
}

export function ScoreHistoryChart({
  scores,
}: {
  scores: WalletScoreResponse[];
}) {
  const data: ScorePoint[] = scores.map((score) => ({
    time: Date.parse(score.createdAt),
    runId: score.runId,
    score: score.composite ?? score.preliminary,
    stage: score.stage,
    passed: score.passed,
  }));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="time"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(time: number) =>
            formatDay(new Date(time).toISOString()).slice(0, 6)
          }
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: 'var(--line)' }}
          minTickGap={48}
        />
        <YAxis
          domain={[0, 1]}
          ticks={[0, 0.25, 0.5, 0.75, 1]}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={36}
        />
        <Tooltip
          content={ScoreTooltip}
          cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="score"
          stroke="var(--accent)"
          strokeWidth={2}
          connectNulls
          dot={{
            r: 4,
            fill: 'var(--accent)',
            stroke: 'var(--panel)',
            strokeWidth: 2,
          }}
          activeDot={{ r: 5, stroke: 'var(--panel)', strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
