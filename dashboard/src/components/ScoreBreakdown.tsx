import type { ScoreComponent, WalletScoreResponse } from '@remora/sdk';
import { useState } from 'react';
import {
  formatAge,
  formatDecimal,
  formatOrdinal,
  formatPercent,
  formatScore,
  humanize,
} from '../format';
import { Badge } from './StatusBadge';

type ComponentName = ScoreComponent['name'];

const COMPONENT_ORDER: ComponentName[] = [
  'significance',
  'drawdown',
  'edge',
  'recency',
  'consistency',
  'copyability',
];

const COMPONENT_LABELS: Record<ComponentName, { title: string; raw: string }> =
  {
    significance: { title: 'Significance', raw: 'PSR' },
    drawdown: { title: 'Drawdown', raw: 'max drawdown' },
    edge: { title: 'Edge', raw: 'PnL per volume' },
    recency: { title: 'Recency', raw: 'Sortino, 30 d' },
    consistency: { title: 'Consistency', raw: 'positive periods' },
    copyability: { title: 'Copyability', raw: 'typical hold' },
  };

function componentColor(name: ComponentName): string {
  return `var(--component-${name})`;
}

function formatRaw(component: ScoreComponent): string {
  const { raw } = component;
  if (raw === null) {
    return '–';
  }
  switch (component.name) {
    case 'significance':
      return raw.toFixed(3);
    case 'drawdown':
      return formatPercent(raw, { digits: 1 });
    case 'edge':
      return `${formatDecimal(raw, 1)} bps`;
    case 'recency':
      return raw.toFixed(2);
    case 'consistency':
      return formatPercent(raw, { digits: 0 });
    case 'copyability':
      return formatAge(Math.exp(raw) * 60_000);
  }
}

function sortComponents(components: ScoreComponent[]): ScoreComponent[] {
  return [...components].sort(
    (left, right) =>
      COMPONENT_ORDER.indexOf(left.name) - COMPONENT_ORDER.indexOf(right.name),
  );
}

function StackedBar({
  components,
  height,
  highlighted,
  onHighlight,
}: {
  components: ScoreComponent[];
  height: number;
  highlighted: ComponentName | null;
  onHighlight?: (name: ComponentName | null) => void;
}) {
  return (
    <div
      className="flex w-full overflow-hidden rounded bg-raised"
      style={{ height }}
    >
      {components
        .filter((component) => component.contribution > 0)
        .map((component) => (
          <div
            key={component.name}
            onPointerEnter={() => onHighlight?.(component.name)}
            onPointerLeave={() => onHighlight?.(null)}
            title={`${COMPONENT_LABELS[component.name].title} ${component.contribution.toFixed(3)}`}
            className="h-full border-r-2 border-panel transition-opacity last:rounded-r"
            style={{
              width: `${component.contribution * 100}%`,
              background: componentColor(component.name),
              opacity:
                highlighted === null || highlighted === component.name
                  ? 1
                  : 0.35,
            }}
          />
        ))}
    </div>
  );
}

export function ScoreBar({
  components,
  score,
}: {
  components: ScoreComponent[] | null;
  score: number | null;
}) {
  if (components === null || components.length === 0) {
    return <span className="text-ink-3">–</span>;
  }
  return (
    <div className="flex w-36 items-center gap-2">
      <StackedBar
        components={sortComponents(components)}
        height={6}
        highlighted={null}
      />
      <span className="w-9 shrink-0 text-right text-ink-2 tabular-nums">
        {formatScore(score)}
      </span>
    </div>
  );
}

export function ScoreBreakdown({ score }: { score: WalletScoreResponse }) {
  const [highlighted, setHighlighted] = useState<ComponentName | null>(null);
  const components = sortComponents(score.components ?? []);
  const total = score.composite ?? score.preliminary;
  const isFinal = score.composite !== null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {total === null ? (
          <p className="text-ink-2">Not ranked in this run</p>
        ) : (
          <p className="text-ink-2">
            <span className="mr-2 text-2xl font-semibold tracking-tight text-ink">
              {formatScore(total)}
            </span>
            {isFinal ? 'final composite' : 'preliminary score'} of 1.000
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="neutral">Stage {score.stage}</Badge>
          {score.passed ? (
            <Badge tone="accent">Passed every gate</Badge>
          ) : (
            score.gateFailures.map((gate) => (
              <Badge key={gate} tone="warn" title={gate}>
                {humanize(gate)}
              </Badge>
            ))
          )}
        </div>
      </div>
      {components.length === 0 ? (
        <p className="text-xs text-ink-3">
          This run stored no components for the wallet, because it stopped
          before ranking.
        </p>
      ) : (
        <>
          <StackedBar
            components={components}
            height={12}
            highlighted={highlighted}
            onHighlight={setHighlighted}
          />
          <div className="-mx-4 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th className="numeric">Raw</th>
                  <th className="numeric">Percentile</th>
                  <th className="numeric">Weight</th>
                  <th className="numeric">Contribution</th>
                </tr>
              </thead>
              <tbody>
                {components.map((component) => (
                  <tr
                    key={component.name}
                    onPointerEnter={() => setHighlighted(component.name)}
                    onPointerLeave={() => setHighlighted(null)}
                    className={
                      highlighted === component.name ? 'bg-raised' : undefined
                    }
                  >
                    <td>
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2.5 shrink-0 rounded-sm"
                          style={{
                            background: componentColor(component.name),
                          }}
                        />
                        <span className="text-ink">
                          {COMPONENT_LABELS[component.name].title}
                        </span>
                        <span className="hidden text-ink-3 sm:inline">
                          {COMPONENT_LABELS[component.name].raw}
                        </span>
                      </span>
                    </td>
                    <td className="numeric text-ink-2">
                      {formatRaw(component)}
                    </td>
                    <td className="numeric text-ink-2">
                      {component.percentile === null
                        ? '–'
                        : formatOrdinal(component.percentile * 100)}
                    </td>
                    <td className="numeric text-ink-3">
                      {component.weight.toFixed(2)}
                    </td>
                    <td className="numeric font-medium text-ink">
                      {component.contribution.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
