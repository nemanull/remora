import { Module } from '@nestjs/common';
import { DetectionClusterController } from './dc.controller';
import { DetectionClusterService } from './dc.service';
import { WalletValidationService } from './walletValidator';
import { WsBroadcastManager } from './ws/wsBroadcastManager';

@Module({
  controllers: [DetectionClusterController],
  providers: [
    DetectionClusterService,
    WalletValidationService,
    WsBroadcastManager,
  ],
  exports: [DetectionClusterService],
})
export class DetectionClusterModule {}
