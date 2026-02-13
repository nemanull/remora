import { Module } from '@nestjs/common';
import { DetectionClusterController } from './dc.controller';
import { DetectionClusterService } from './dc.service';
import { WalletValidationService } from './walletValidator';


@Module({
  controllers: [DetectionClusterController],
  providers: [DetectionClusterService, WalletValidationService],
  exports: [DetectionClusterService],
})
export class DetectionClusterModule {}
