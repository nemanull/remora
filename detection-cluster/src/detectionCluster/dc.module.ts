import { Module } from '@nestjs/common';
import { DetectionClusterController } from './dc.controller';
import { DetectionClusterService } from './dc.service';
import { WalletValidationService } from './walletValidator';


export const CLUSTER_ID_TOKEN = 'CLUSTER_ID_TOKEN';

function resolveClusterId(): number {
  const rawClusterId = process.env.CLUSTER_ID ?? process.env.cluster_id ?? '1';
  const parsed = Number.parseInt(rawClusterId, 10);

  if (Number.isNaN(parsed)) {
    throw new Error('CLUSTER_ID must be a valid number');
  }

  return parsed;
}

@Module({
  controllers: [DetectionClusterController],
  providers: [
    {
      provide: CLUSTER_ID_TOKEN,
      useFactory: resolveClusterId,
    },
    DetectionClusterService,
    WalletValidationService,
  ],
  exports: [DetectionClusterService],
})
export class DetectionClusterModule {}
