import { Injectable, Logger } from '@nestjs/common';
import { validateWallet } from '@remora/sdk';
import { Decimal } from 'decimal.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasDump, loadAccountValue, loadFills } from './scoring/dumps';
import {
  computeWalletStats,
  rankByScore,
  WalletStats,
} from './scoring/profitability';

const WALLETS_FILE = join(process.cwd(), 'data', 'wallets.txt');

export type SkippedWallet = {
  wallet: string;
  reason: string;
};

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  rankWallets() {
    const stats: WalletStats[] = [];
    const skipped: SkippedWallet[] = [];

    for (const line of this.readWalletList()) {
      const wallet = validateWallet(line);
      if (!wallet) {
        skipped.push({ wallet: line, reason: 'invalid_wallet' });
        continue;
      }

      if (!hasDump(wallet)) {
        skipped.push({ wallet, reason: 'no_dump' });
        continue;
      }

      stats.push(this.computeStats(wallet));
    }

    this.logger.log(
      `Ranked ${stats.length} wallets, skipped ${skipped.length}`,
    );

    return {
      ranked: rankByScore(stats),
      skipped,
    };
  }

  scoreWallet(wallet: string) {
    const validWallet = validateWallet(wallet);
    if (!validWallet) {
      return { success: false, reason: 'invalid_wallet', wallet };
    }

    if (!hasDump(validWallet)) {
      return { success: false, reason: 'no_dump', wallet: validWallet };
    }

    const [score] = rankByScore([this.computeStats(validWallet)]);

    return { success: true, reason: 'ok', score };
  }

  private computeStats(wallet: string): WalletStats {
    const fills = loadFills(wallet);
    const accountValue = loadAccountValue(wallet) ?? new Decimal(0);

    return computeWalletStats(wallet, fills, accountValue);
  }

  private readWalletList(): string[] {
    return readFileSync(WALLETS_FILE, 'utf8')
      .split('\n')
      .map((line) => line.split('#')[0].trim())
      .filter((line) => line.length > 0);
  }
}
