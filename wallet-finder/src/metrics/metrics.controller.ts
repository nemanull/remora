import { Controller, Get, Header } from '@nestjs/common';
import { Registry } from 'prom-client';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  readMetrics(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
