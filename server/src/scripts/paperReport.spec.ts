import type { CopyGapResponse } from '@remora/sdk';
import { describe, expect, it } from 'vitest';
import {
  type PaperReport,
  renderPaperReport,
  sumCopyGaps,
} from './paperReport';

function gap(
  book: 'MAIN' | 'SHADOW',
  parts: Partial<CopyGapResponse> = {},
): CopyGapResponse {
  return {
    positionId: '1',
    book,
    coin: 'BTC',
    closedAt: '2026-05-04T10:00:00.000Z',
    isLeaderEpisodeClosed: true,
    copyPnl: '1.500000',
    scaledLeaderPnl: '2.000000',
    totalGap: '-0.500000',
    entryDrift: '-0.200000',
    exitDrift: '-0.100000',
    feeDifference: '-0.150000',
    funding: '0.000000',
    residual: '-0.050000',
    ...parts,
  };
}

function report(overrides: Partial<PaperReport> = {}): PaperReport {
  return {
    label: 'paper, simulated market',
    market: 'simulator',
    since: new Date('2026-05-04T10:00:00.000Z'),
    until: new Date('2026-05-04T10:45:00.000Z'),
    generatedAt: new Date('2026-05-04T10:46:00.000Z'),
    activity: [['decisions', 12]],
    decisions: [
      { book: 'SHADOW', verdict: 'COPY', reason: 'copied', count: 9 },
    ],
    latency: [
      {
        step: 'collector receive to decision',
        samples: 9,
        p50: 21.5,
        p90: 40,
        p99: 61.2,
      },
    ],
    gaps: sumCopyGaps([gap('SHADOW')]),
    closedCopies: 2,
    scoringRuns: [],
    leaders: [['SHADOW', 6]],
    ...overrides,
  };
}

describe('sumCopyGaps', () => {
  it('adds every part of the gap per book', () => {
    const [main, shadow] = sumCopyGaps([
      gap('SHADOW'),
      gap('MAIN', { copyPnl: '-3.250000', residual: '0.010000' }),
      gap('SHADOW', { funding: '0.420000' }),
    ]);

    expect(main.book).toBe('MAIN');
    expect(main.copies).toBe(1);
    expect(main.copyPnl.toFixed()).toBe('-3.25');
    expect(shadow.copies).toBe(2);
    expect(shadow.copyPnl.toFixed()).toBe('3');
    expect(shadow.entryDrift.toFixed()).toBe('-0.4');
    expect(shadow.funding.toFixed()).toBe('0.42');
  });

  it('prints a part that rounds to zero without a sign', () => {
    const markdown = renderPaperReport(
      report({ gaps: sumCopyGaps([gap('SHADOW', { residual: '-0.001' })]) }),
    );

    expect(markdown).toContain('| 0.00 |');
    expect(markdown).not.toContain('-0.00');
  });

  it('answers no totals without closed copies', () => {
    expect(sumCopyGaps([])).toEqual([]);
  });
});

describe('renderPaperReport', () => {
  it('labels every table with the run label and states the market', () => {
    const markdown = renderPaperReport(report());

    expect(markdown).toContain(
      'Every number in this report is labelled paper, simulated market.',
    );
    expect(markdown).toContain('against hyperliquid-sim');
    expect(markdown).toContain(
      '| collector receive to decision | 9 | 21.5 | 40 | 61.2 |',
    );
    expect(markdown).toContain(
      '| SHADOW | 1 | 1.50 | 2.00 | -0.50 | -0.20 | -0.10 | -0.15 | 0.00 | -0.05 |',
    );
    expect(markdown).toContain(
      '2 copies closed in the window, and 1 of them have a measurable leader episode.',
    );
  });

  it('describes a run against the real API as paper only', () => {
    const markdown = renderPaperReport(
      report({ label: 'paper', market: 'hyperliquid' }),
    );

    expect(markdown).toContain(
      'Every number in this report is labelled paper.',
    );
    expect(markdown).toContain('against the Hyperliquid API');
  });
});
