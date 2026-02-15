import { Inject, Injectable } from '@nestjs/common';
import { validateWallet } from '@copy-quant/sdk';
import { CLUSTER_ID_TOKEN } from './dc.module';

export interface WalletValidationResult {
  success: boolean;
  reason: string;
  validWallets: string[];
  invalidWallets?: string[];
  maxAllowed?: number;
  providedCount?: number;
  clusterId: number;
}

@Injectable()
export class WalletValidationService {
  constructor(@Inject(CLUSTER_ID_TOKEN) private readonly clusterId: number) {}

  async checkAllWallets(wallets: string[]): Promise<WalletValidationResult> {
    if (!Array.isArray(wallets) || wallets.length === 0) {
      return {
        success: false,
        reason: 'no_wallets_provided',
        validWallets: [],
        clusterId: this.clusterId,
      };
    }

    const validWallets: string[] = [];
    const invalidWallets: string[] = [];

    for (const wallet of wallets) {
      const validatedWallet = validateWallet(wallet);
      if (validatedWallet) {
        validWallets.push(validatedWallet);
      } else {
        invalidWallets.push(wallet);
      }
    }

    if (invalidWallets.length > 0) {
      return {
        success: false,
        reason: 'invalid_wallet_addresses',
        validWallets,
        invalidWallets,
        clusterId: this.clusterId,
      };
    }

    if (validWallets.length > 8) {
      return {
        success: false,
        reason: 'too_many_wallets',
        validWallets: validWallets.slice(0, 8),
        maxAllowed: 8,
        providedCount: validWallets.length,
        clusterId: this.clusterId,
      };
    }

    return {
      success: true,
      reason: 'ok',
      validWallets,
      clusterId: this.clusterId,
    };
  }
}
