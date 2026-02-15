import { Body, Controller, Post } from '@nestjs/common';
import { DetectionClusterService } from './dc.service';
import { resolveClusterIdFromEnv } from './dc.tokens';
import { WalletValidationService } from './walletValidator';

@Controller('cluster')
export class DetectionClusterController {
  private readonly clusterId = resolveClusterIdFromEnv();

  constructor(
    private readonly detectionClusterService: DetectionClusterService,
    private readonly walletValidationService: WalletValidationService,
  ) {}

  @Post('start')
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

    await this.detectionClusterService.startDetectionForAllWallets(normalizedWallets);

    return {
      success: true,
      reason: 'detection_started',
      validWallets: normalizedWallets,
      clusterId: this.clusterId,
    };
  }
}
