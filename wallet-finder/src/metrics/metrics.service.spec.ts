import { WeightBudget } from '@remora/sdk';
import { describe, expect, it } from 'vitest';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  it('exports the weight the budget spent, labelled with the process', async () => {
    const budget = new WeightBudget(600);
    const metrics = new MetricsService(budget);
    await budget.take(20);
    budget.charge(3);

    const first = await metrics.registry.metrics();
    await budget.take(20);
    const second = await metrics.registry.metrics();

    expect(first).toContain(
      'remora_hyperliquid_weight_used_total{process="wallet-finder"} 23',
    );
    expect(second).toContain(
      'remora_hyperliquid_weight_used_total{process="wallet-finder"} 43',
    );
  });

  it('registers the run duration and the wallets scored per stage', async () => {
    const metrics = new MetricsService(new WeightBudget(600));
    metrics.discoveryWalletsScoredTotal.inc({ stage: '2' });

    const names = (await metrics.registry.getMetricsAsJSON()).map(
      (metric) => metric.name,
    );

    expect(names).toEqual(
      expect.arrayContaining([
        'remora_discovery_run_duration_seconds',
        'remora_discovery_wallets_scored_total',
        'remora_hyperliquid_weight_used_total',
        'remora_hyperliquid_rate_limited_total',
      ]),
    );
  });
});
