import { Injectable } from '@nestjs/common';
import { validateWallet } from '@copy-quant/sdk';

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
    private readonly cluster_id:number

    constructor(
        cluster_id: number
    ) {
        this.cluster_id = cluster_id;
    }


    checkAllWallets(wallets: string[]): WalletValidationResult {
        if (!Array.isArray(wallets) || wallets.length === 0) {
            return {
                success: false,
                reason: 'no_wallets_provided',
                validWallets: [],
                clusterId: this.cluster_id,
            };
        }

        const validWallets: string[] = [];
        const invalidWallets: string[] = [];

        for (const wallet of wallets) {
            if (validateWallet(wallet)) {
                validWallets.push(wallet);
            }
            else {
                invalidWallets.push(wallet);
            }
        }

        if (invalidWallets.length > 0) {
            return {
                success: false,
                reason: 'invalid_wallet_addresses',
                validWallets,
                invalidWallets,
                clusterId: this.cluster_id,
            };
        }

        if (validWallets.length > 8) {
            return {
                success: false,
                reason: 'too_many_wallets',
                validWallets: validWallets.slice(0, 8),
                maxAllowed: 8,
                providedCount: validWallets.length,
                clusterId: this.cluster_id,
            };
        }

        return {
            success: true,
            reason: 'ok',
            validWallets,
            clusterId: this.cluster_id,
        };
    }
}