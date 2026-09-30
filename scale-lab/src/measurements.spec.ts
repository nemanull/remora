import { describe, expect, it } from 'vitest';
import {
  measurePerMinute,
  readPrometheusValue,
  summarizeSamples,
} from './measurements';

describe('readPrometheusValue', () => {
  const exposition = [
    '# HELP nodejs_eventloop_lag_p99_seconds The 99th percentile of the recorded event loop delays.',
    '# TYPE nodejs_eventloop_lag_p99_seconds gauge',
    'nodejs_eventloop_lag_p99_seconds 0.012058623',
    'nodejs_eventloop_lag_p99_seconds_extra 7',
  ].join('\n');

  it('reads an unlabelled sample by its exact name', () => {
    expect(
      readPrometheusValue(exposition, 'nodejs_eventloop_lag_p99_seconds'),
    ).toBe(0.012058623);
  });

  it('answers null for a missing metric', () => {
    expect(readPrometheusValue(exposition, 'process_cpu_seconds_total')).toBe(
      null,
    );
  });
});

describe('summarizeSamples', () => {
  it('gives the median and the maximum', () => {
    expect(summarizeSamples([5, 1, 3])).toEqual({
      samples: 3,
      median: 3,
      max: 5,
    });
    expect(summarizeSamples([4, 1, 3, 2])).toEqual({
      samples: 4,
      median: 2.5,
      max: 4,
    });
  });

  it('answers nulls without samples', () => {
    expect(summarizeSamples([])).toEqual({
      samples: 0,
      median: null,
      max: null,
    });
  });
});

describe('measurePerMinute', () => {
  it('turns counter samples into the amount spent over each full minute', () => {
    const samples = [0, 30, 60, 90, 120].map((seconds, index) => ({
      at: seconds * 1_000,
      total: index * 100,
    }));

    expect(measurePerMinute(samples)).toEqual([200, 200, 200]);
  });

  it('skips windows across a counter reset and windows shorter than a minute', () => {
    const samples = [
      { at: 0, total: 500 },
      { at: 30_000, total: 600 },
      { at: 60_000, total: 20 },
      { at: 90_000, total: 80 },
    ];

    expect(measurePerMinute(samples)).toEqual([]);
    expect(measurePerMinute(samples.slice(0, 2))).toEqual([]);
  });
});
