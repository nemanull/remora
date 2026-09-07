import {
  reconnectDelayMs,
  type HyperliquidFill,
  type HyperliquidInfoClient,
} from '@remora/sdk';

export const FILLS_PAGE_SIZE = 2_000;
export const TRUNCATED_AFTER_FULL_PAGES = 5;
export const BACKFILL_LAG_LIMIT_MS = 120_000;

export type FillPage = {
  fills: HyperliquidFill[];
  nextStartTime: number;
  isTruncated: boolean;
  isLagging: boolean;
  receivedAt: number;
};

export type FillBackfillOptions = {
  signal?: AbortSignal;
  readTargetTime?: () => number | null;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  onLagWait?: (
    coveredUntil: number,
    targetTime: number,
    delayMs: number,
  ) => void;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

async function readPage(
  infoClient: Pick<HyperliquidInfoClient, 'userFillsByTime'>,
  wallet: string,
  startTime: number,
  options: FillBackfillOptions,
): Promise<HyperliquidFill[] | null> {
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) {
      return null;
    }
    try {
      return await infoClient.userFillsByTime(wallet, startTime);
    } catch (error) {
      if (options.signal?.aborted) {
        return null;
      }
      const delayMs = reconnectDelayMs(attempt);
      options.onRetry?.(error, attempt + 1, delayMs);
      await sleep(delayMs, options.signal);
    }
  }
}

export async function* readFillsSince(
  infoClient: Pick<HyperliquidInfoClient, 'userFillsByTime'>,
  wallet: string,
  startTime: number,
  options: FillBackfillOptions = {},
): AsyncGenerator<FillPage> {
  const seenTids = new Set<number>();
  let cursor = startTime;
  let coveredUntil = startTime;
  let fullPages = 0;
  let lagWaits = 0;
  let lagStartedAt: number | null = null;
  for (;;) {
    const page = await readPage(infoClient, wallet, cursor, options);
    if (page === null || options.signal?.aborted) {
      return;
    }
    const fills = page.filter((fill) => !seenTids.has(fill.tid));
    for (const fill of fills) {
      seenTids.add(fill.tid);
    }
    if (page.length >= FILLS_PAGE_SIZE) {
      fullPages += 1;
    }
    const nextStartTime = page.length > 0 ? page[page.length - 1].time : cursor;
    coveredUntil = Math.max(coveredUntil, nextStartTime);
    const isLastPage = page.length < FILLS_PAGE_SIZE || fills.length === 0;
    const targetTime = isLastPage ? (options.readTargetTime?.() ?? null) : null;
    const isBehindTarget = targetTime !== null && coveredUntil < targetTime;
    const receivedAt = Date.now();
    if (isBehindTarget && lagStartedAt === null) {
      lagStartedAt = receivedAt;
    }
    const hasGivenUp =
      isBehindTarget &&
      lagStartedAt !== null &&
      receivedAt - lagStartedAt >= BACKFILL_LAG_LIMIT_MS;
    yield {
      fills,
      nextStartTime,
      isTruncated: fullPages >= TRUNCATED_AFTER_FULL_PAGES,
      isLagging: hasGivenUp,
      receivedAt,
    };
    if (isLastPage && (!isBehindTarget || hasGivenUp)) {
      return;
    }
    if (isLastPage) {
      const delayMs = reconnectDelayMs(lagWaits);
      lagWaits += 1;
      options.onLagWait?.(coveredUntil, targetTime ?? coveredUntil, delayMs);
      await sleep(delayMs, options.signal);
      if (options.signal?.aborted) {
        return;
      }
    }
    cursor = nextStartTime;
  }
}
