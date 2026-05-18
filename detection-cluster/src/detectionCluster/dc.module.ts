import { Module } from '@nestjs/common';
import { DetectionClusterController } from './dc.controller';
import { DetectionClusterService } from './dc.service';
import { WalletValidationService } from './walletValidator';
import { WsBroadcastManager } from './ws/wsBroadcastManager';
import { WsCoreClient } from './ws/wsCoreClient';

@Module({
  controllers: [DetectionClusterController],
  providers: [
    DetectionClusterService,
    WalletValidationService,
    WsBroadcastManager,
    WsCoreClient,
  ],
  exports: [DetectionClusterService],
})
export class DetectionClusterModule {}
