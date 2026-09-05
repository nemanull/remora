const WINDOW_MS = 60_000;
const BURST_MS = 5_000;

type Spend = { at: number; weight: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WeightBudget {
  private readonly refillPerMs: number;
  private readonly capacity: number;
  private balance: number;
  private refilledAt = Date.now();
  private pausedUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly recentSpends: Spend[] = [];
  private usedTotal = 0;

  constructor(readonly weightPerMinute: number) {
    this.refillPerMs = weightPerMinute / WINDOW_MS;
    this.capacity = weightPerMinute * (BURST_MS / WINDOW_MS);
    this.balance = this.capacity;
  }

  take(weight: number): Promise<void> {
    const turn = this.queue
      .then(() => this.waitForPositiveBalance())
      .then(() => this.spend(weight));
    this.queue = turn;
    return turn;
  }

  charge(weight: number): void {
    if (weight > 0) {
      this.spend(weight);
    }
  }

  pauseFor(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  readUsedLastMinute(): number {
    this.forgetOldSpends();
    return this.recentSpends.reduce((sum, spend) => sum + spend.weight, 0);
  }

  readUsedTotal(): number {
    return this.usedTotal;
  }

  private async waitForPositiveBalance(): Promise<void> {
    for (
      let waitMs = this.measureWaitMs();
      waitMs > 0;
      waitMs = this.measureWaitMs()
    ) {
      await sleep(waitMs);
    }
  }

  private measureWaitMs(): number {
    this.refill();
    const pausedForMs = this.pausedUntil - Date.now();
    if (pausedForMs > 0) {
      return pausedForMs;
    }
    if (this.balance > 0) {
      return 0;
    }
    return Math.max(1, Math.ceil(-this.balance / this.refillPerMs));
  }

  private refill(): void {
    const now = Date.now();
    this.balance = Math.min(
      this.capacity,
      this.balance + (now - this.refilledAt) * this.refillPerMs,
    );
    this.refilledAt = now;
  }

  private spend(weight: number): void {
    this.refill();
    this.balance -= weight;
    this.usedTotal += weight;
    this.recentSpends.push({ at: Date.now(), weight });
    this.forgetOldSpends();
  }

  private forgetOldSpends(): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.recentSpends.length > 0 && this.recentSpends[0].at <= cutoff) {
      this.recentSpends.shift();
    }
  }
}
