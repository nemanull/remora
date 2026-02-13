
export type walletStatus = {
    wallet: string;
    isValid: boolean;
    error?: string;
}


export function validateWallet(wallet: string): string | null {
    if(wallet.length === 42 && wallet.startsWith('0x')){
        return wallet;
    }

    return null
}






