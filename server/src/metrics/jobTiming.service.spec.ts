import type { WorkerHost } from '@nestjs/bullmq';
import type { DiscoveryService } from '@nestjs/core';
import type { Job } from 'bullmq';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { JobTimingService } from './jobTiming.service';
import { MetricsService } from './metrics.service';

function createWorker(name: string) {
  const worker = Object.assign(new EventEmitter(), { name });
  return { worker, host: { worker } as unknown as WorkerHost };
}

function job(name: string, processedOn: number, finishedOn?: number): Job {
  return { name, processedOn, finishedOn } as Job;
}

function createService() {
  const metrics = new MetricsService();
  const service = new JobTimingService(
    { getProviders: () => [] } as unknown as DiscoveryService,
    metrics,
  );
  return { metrics, service };
}

describe('JobTimingService', () => {
  it('records the duration of a completed job under its queue and name', async () => {
    const { metrics, service } = createService();
    const { worker, host } = createWorker('maintenance');
    service.timeJobs(host);

    worker.emit('completed', job('snapshot-books', 1_000, 3_500));

    const duration = await metrics.jobDurationSeconds.get();
    expect(duration.values).toContainEqual(
      expect.objectContaining({
        metricName: 'remora_job_duration_seconds_sum',
        labels: { queue: 'maintenance', job: 'snapshot-books' },
        value: 2.5,
      }),
    );
    const failures = await metrics.jobFailuresTotal.get();
    expect(failures.values).toEqual([]);
  });

  it('counts every failed attempt once and still records its duration', async () => {
    const { metrics, service } = createService();
    const { worker, host } = createWorker('notifications');
    service.timeJobs(host);

    worker.emit('failed', job('send-telegram', 1_000, 1_200), new Error('x'));
    worker.emit('failed', job('send-telegram', 2_000, 2_100), new Error('x'));
    worker.emit('failed', undefined, new Error('stalled'));

    const failures = await metrics.jobFailuresTotal.get();
    expect(failures.values).toEqual([
      {
        labels: { queue: 'notifications', job: 'send-telegram' },
        value: 2,
      },
    ]);
    const duration = await metrics.jobDurationSeconds.get();
    expect(duration.values).toContainEqual(
      expect.objectContaining({
        metricName: 'remora_job_duration_seconds_count',
        labels: { queue: 'notifications', job: 'send-telegram' },
        value: 2,
      }),
    );
  });
});
