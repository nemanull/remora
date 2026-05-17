import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { validateWallet } from '@remora/sdk';
import { Job, UnrecoverableError } from 'bullmq';
import { Decimal } from 'decimal.js';
import { hasDump, loadAccountValue, loadFills } from '../scoring/dumps';
import {
  computeWalletStats,
  rankByScore,
  WalletScore,
} from '../scoring/profitability';

export const SCORING_QUEUE = 'scoring';

export type ScoreWalletJob = {
  wallet: string;
};

// TODO: nothing enqueues yet, the core should once it picks wallets
@Processor(SCORING_QUEUE)
export class ScoringWorker extends WorkerHost {
  private readonly logger = new Logger(ScoringWorker.name);

  process(job: Job<ScoreWalletJob>): Promise<WalletScore> {
    const wallet = validateWallet(job.data.wallet);
    if (!wallet) {
      throw new UnrecoverableError(`Invalid wallet ${job.data.wallet}`);
    }

    if (!hasDump(wallet)) {
      throw new UnrecoverableError(`No dump for wallet ${wallet}`);
    }

    const stats = computeWalletStats(
      wallet,
      loadFills(wallet),
      loadAccountValue(wallet) ?? new Decimal(0),
    );
    const [score] = rankByScore([stats]);
    this.logger.log(`Scored wallet ${wallet} at ${score.score}`);

    return Promise.resolve(score);
  }
}
