import { Body, Controller, Inject, Post } from '@nestjs/common';
import { DetectionClusterService } from './dc.service';
import { CLUSTER_ID_TOKEN } from './dc.module';
import { WalletValidationService } from './walletValidator';

@Controller('cluster')
export class DetectionClusterController {
  constructor(
    private readonly detectionClusterService: DetectionClusterService,
    private readonly walletValidationService: WalletValidationService,
    @Inject(CLUSTER_ID_TOKEN) private readonly clusterId: number,
  ) {}

  @Post('setup')
  async startDetection(@Body('wallets') wallets: string[]) {
    const validationResult = await this.walletValidationService.checkAllWallets(
      wallets,
    );

    if (!validationResult.success) {
      return validationResult;
    }

    const normalizedWallets = validationResult.validWallets.map((wallet) =>
      wallet.toLowerCase(),
    );

    await this.detectionClusterService.startDetection(normalizedWallets);

    return {
      success: true,
      reason: 'detection_started',
      validWallets: normalizedWallets,
      clusterId: this.clusterId,
    };
  }
}
