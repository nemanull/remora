import { Body, Controller, Post } from '@nestjs/common';
import { DetectionClusterService } from './dc.service';
import { WalletValidationService } from './walletValidator';

@Controller('cluster-1')
export class DetectionClusterController {

    private readonly cluster_id:number = 1;
    
    constructor(
        private readonly detectionClusterService: DetectionClusterService,
        private readonly walletValidationService: WalletValidationService,
    ){}

    

    @Post('start')
    async startDetection(@Body('wallets') wallets: string[]) {
        const validationResult = this.walletValidationService.checkAllWallets(wallets);

        if (!validationResult.success) {
            return validationResult;
        }

        const lowerCaseWallets = validationResult.validWallets.map(wallet => wallet.toLowerCase());

        await this.detectionClusterService.startDetection(lowerCaseWallets);

        return {
            success: true,
            reason: 'detection_started',
            validWallets: validationResult.validWallets,
            clusterId: this.cluster_id,
        };

    }








}
