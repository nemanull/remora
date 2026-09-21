import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { DiscoveryRunResponse } from '@remora/sdk';
import { DiscoveryStartService } from '../leaders/discoveryStart.service';

@Controller('api/discovery')
export class DiscoveryController {
  constructor(private readonly discoveryStart: DiscoveryStartService) {}

  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  async startRun(): Promise<DiscoveryRunResponse> {
    const run = await this.discoveryStart.startDiscovery();
    return {
      runId: run.runId,
      startedAt: run.startedAt,
      trackedAddresses: run.trackedAddresses.length,
    };
  }
}
