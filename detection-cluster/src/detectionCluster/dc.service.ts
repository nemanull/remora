import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLUSTER_ID_TOKEN } from './dc.module';

@Injectable()
export class DetectionClusterService {
  private readonly logger = new Logger(DetectionClusterService.name);

  constructor(@Inject(CLUSTER_ID_TOKEN) private readonly clusterId: number) {}

  async startDetection(wallets: string[]) {
    this.logger.log(
      `Starting detection for cluster ${this.clusterId} with ${wallets.length} wallets`,
    );
  }
}
