import { WorkerHost } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Job } from 'bullmq';
import { MetricsService } from './metrics.service';

function isWorkerHost(instance: unknown): instance is WorkerHost {
  return instance instanceof WorkerHost;
}

@Injectable()
export class JobTimingService implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metrics: MetricsService,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (isWorkerHost(instance)) {
        this.timeJobs(instance);
      }
    }
  }

  timeJobs(host: WorkerHost): void {
    const worker = host.worker;
    worker.on('completed', (job) => this.recordDuration(worker.name, job));
    worker.on('failed', (job) => {
      if (job === undefined) {
        return;
      }
      this.recordDuration(worker.name, job);
      this.metrics.jobFailuresTotal.inc({ queue: worker.name, job: job.name });
    });
  }

  private recordDuration(queue: string, job: Job): void {
    if (job.processedOn === undefined) {
      return;
    }
    const finishedAt = job.finishedOn ?? Date.now();
    this.metrics.jobDurationSeconds.observe(
      { queue, job: job.name },
      Math.max(0, finishedAt - job.processedOn) / 1_000,
    );
  }
}
