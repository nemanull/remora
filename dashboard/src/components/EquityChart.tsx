import type { BookEquityPointResponse } from '@remora/sdk';
import { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';
import {
  formatCompactUsd,
  formatDateTime,
  formatTime,
  formatUsd,
  formatWholeUsd,
  toneOf,
} from '../format';

type ChartPoint = {
  time: number;
  value: number;
  isPnl: boolean;
  unrealizedPnl: number;
  openPositions: number;
};

const DAY_MS = 86_400_000;
const COMPACT_SPAN_USD = 5_000;
const AXIS_TICK = { fill: 'var(--ink-3)', fontSize: 11 };

function EquityTooltip({ active, payload }: TooltipContentProps) {
  const point = payload?.[0]?.payload as ChartPoint | undefined;
  if (!active || point === undefined) {
    return null;
  }
  return (
    <div className="rounded-md border border-line-strong bg-panel px-3 py-2 text-xs shadow-lg shadow-black/20">
      <p
        className={`text-sm font-semibold tabular-nums ${point.isPnl ? toneOf(point.value) : 'text-ink'}`}
      >
        {formatUsd(point.value, { signed: point.isPnl })}
        <span className="ml-1.5 text-xs font-normal text-ink-3">
          {point.isPnl ? 'net PnL' : 'equity'}
        </span>
      </p>
      <p className="mt-0.5 text-ink-3">
        {formatDateTime(new Date(point.time).toISOString())} UTC
      </p>
      <p className="mt-1.5 flex justify-between gap-4 text-ink-2">
        <span>Unrealized</span>
        <span className={`tabular-nums ${toneOf(point.unrealizedPnl)}`}>
          {formatUsd(point.unrealizedPnl, { signed: true })}
        </span>
      </p>
      <p className="flex justify-between gap-4 text-ink-2">
        <span>Open copies</span>
        <span className="tabular-nums">{point.openPositions}</span>
      </p>
    </div>
  );
}

export function EquityChart({
  points,
  height = 260,
}: {
  points: BookEquityPointResponse[];
  height?: number;
}) {
  const gradientId = useId();
  const data: ChartPoint[] = points.map((point) => ({
    time: Date.parse(point.takenAt),
    value: Number(point.valueUsd),
    isPnl: point.valueKind === 'net_pnl',
    unrealizedPnl: Number(point.unrealizedPnl),
    openPositions: point.openPositions,
  }));
  const timeSpan =
    data.length > 1 ? data[data.length - 1].time - data[0].time : 0;
  const values = data.map((point) => point.value);
  const valueSpan = Math.max(...values) - Math.min(...values);
  const formatTimeTick = (time: number) => {
    const iso = new Date(time).toISOString();
    return timeSpan <= DAY_MS
      ? formatTime(iso).slice(0, 5)
      : formatDateTime(iso);
  };
  const formatValueTick = (value: number) =>
    valueSpan >= COMPACT_SPAN_USD
      ? formatCompactUsd(value)
      : formatWholeUsd(value);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.16} />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="time"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={formatTimeTick}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: 'var(--line)' }}
          padding={{ left: 8, right: 8 }}
          minTickGap={56}
        />
        <YAxis
          domain={['auto', 'auto']}
          tickFormatter={formatValueTick}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={valueSpan >= COMPACT_SPAN_USD ? 60 : 72}
          allowDecimals={false}
        />
        <Tooltip
          content={EquityTooltip}
          cursor={{ stroke: 'var(--line-strong)', strokeWidth: 1 }}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--accent)"
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          baseValue="dataMin"
          dot={false}
          activeDot={{ r: 4, stroke: 'var(--panel)', strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
