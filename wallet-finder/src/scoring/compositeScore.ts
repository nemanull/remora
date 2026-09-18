import type { ScoreComponent } from '@remora/sdk';

export type ComponentName = ScoreComponent['name'];

export type ComponentValues = Record<ComponentName, number | null>;

export type RankedScore = {
  composite: number;
  components: ScoreComponent[];
};

export const COMPONENT_WEIGHTS: Record<ComponentName, number> = {
  significance: 0.3,
  drawdown: 0.2,
  edge: 0.15,
  recency: 0.15,
  consistency: 0.1,
  copyability: 0.1,
};

export const PRELIMINARY_COMPONENTS: ComponentName[] = [
  'significance',
  'drawdown',
  'edge',
  'recency',
  'consistency',
];

export const FINAL_COMPONENTS: ComponentName[] = [
  ...PRELIMINARY_COMPONENTS,
  'copyability',
];

const WINSOR_LOWER = 0.05;
const WINSOR_UPPER = 0.95;

export function computeQuantile(sortedValues: number[], share: number): number {
  const position = (sortedValues.length - 1) * share;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    sortedValues[lower] +
    (sortedValues[upper] - sortedValues[lower]) * (position - lower)
  );
}

export function computePercentileRank(
  sortedValues: number[],
  value: number,
): number {
  let below = 0;
  let equal = 0;
  for (const candidate of sortedValues) {
    if (candidate < value) {
      below += 1;
    } else if (candidate === value) {
      equal += 1;
    }
  }
  return (below + equal / 2) / sortedValues.length;
}

function scaleWeights(names: ComponentName[]): Record<ComponentName, number> {
  const total = names.reduce((sum, name) => sum + COMPONENT_WEIGHTS[name], 0);
  return Object.fromEntries(
    names.map((name) => [name, COMPONENT_WEIGHTS[name] / total]),
  ) as Record<ComponentName, number>;
}

export function rankCohort(
  cohort: ReadonlyMap<string, ComponentValues>,
  names: ComponentName[],
): Map<string, RankedScore> {
  const weights = scaleWeights(names);
  const bounds = new Map<ComponentName, { low: number; high: number }>();
  const winsorizedByName = new Map<ComponentName, number[]>();
  for (const name of names) {
    const sorted = [...cohort.values()]
      .map((values) => values[name])
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right);
    if (sorted.length === 0) {
      continue;
    }
    const low = computeQuantile(sorted, WINSOR_LOWER);
    const high = computeQuantile(sorted, WINSOR_UPPER);
    bounds.set(name, { low, high });
    winsorizedByName.set(
      name,
      sorted.map((value) => Math.min(Math.max(value, low), high)),
    );
  }
  const ranked = new Map<string, RankedScore>();
  for (const [address, values] of cohort) {
    const components = names.map((name): ScoreComponent => {
      const raw = values[name];
      const bound = bounds.get(name);
      const winsorizedValues = winsorizedByName.get(name);
      if (raw === null || !bound || !winsorizedValues) {
        return {
          name,
          raw,
          winsorized: null,
          percentile: null,
          weight: weights[name],
          contribution: 0,
        };
      }
      const winsorized = Math.min(Math.max(raw, bound.low), bound.high);
      const percentile = computePercentileRank(winsorizedValues, winsorized);
      return {
        name,
        raw,
        winsorized,
        percentile,
        weight: weights[name],
        contribution: weights[name] * percentile,
      };
    });
    ranked.set(address, {
      composite: components.reduce(
        (sum, component) => sum + component.contribution,
        0,
      ),
      components,
    });
  }
  return ranked;
}
