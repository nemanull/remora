import { reconnectDelayMs, type HyperliquidFill } from '@remora/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKFILL_LAG_LIMIT_MS,
  readFillsSince,
  type FillPage,
} from './fillBackfill';

vi.mock('@remora/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@remora/sdk')>()),
  reconnectDelayMs: vi.fn(() => 1),
}));

const WALLET = '0x4e23288cee4960f9f962195c22948e4bc7ae20c3';
const START = 1_777_000_000_000;

function createFill(tid: number, time: number): HyperliquidFill {
  return {
    coin: 'BTC',
    px: '84512.0',
    sz: '0.001',
    side: 'B',
    time,
    startPosition: '0.0',
    dir: 'Open Long',
    closedPnl: '0.0',
    hash: '0x00',
    oid: tid,
    crossed: true,
    fee: '0.038',
    tid,
    feeToken: 'USDC',
    twapId: null,
  };
}

function createFills(
  firstTid: number,
  count: number,
  time: (index: number) => number,
): HyperliquidFill[] {
  return Array.from({ length: count }, (_, index) =>
    createFill(firstTid + index, time(index)),
  );
}

function createClient(pages: (HyperliquidFill[] | Error)[]) {
  const requests: number[] = [];
  const client = {
    userFillsByTime: vi.fn((_wallet: string, startTime: number) => {
      requests.push(startTime);
      const page = pages.shift();
      if (page === undefined) {
        return Promise.reject(new Error('no page left'));
      }
      return page instanceof Error
        ? Promise.reject(page)
        : Promise.resolve(page);
    }),
  };
  return { client, requests };
}

async function collect(
  generator: AsyncGenerator<FillPage>,
): Promise<FillPage[]> {
  const pages: FillPage[] = [];
  for await (const page of generator) {
    pages.push(page);
  }
  return pages;
}

describe('readFillsSince', () => {
  beforeEach(() => {
    vi.mocked(reconnectDelayMs).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads from the cursor until REST reaches the target time and only then ends', async () => {
    const lagWaits: [number, number][] = [];
    const dropped = createFill(3, START + 3_000);
    const { client, requests } = createClient([
      [createFill(1, START + 1_000)],
      [createFill(1, START + 1_000)],
      [createFill(1, START + 1_000), dropped],
    ]);
    const pages = await collect(
      readFillsSince(client, WALLET, START, {
        readTargetTime: () => START + 3_000,
        onLagWait: (coveredUntil, targetTime) =>
          lagWaits.push([coveredUntil, targetTime]),
      }),
    );
    expect(requests).toEqual([START, START + 1_000, START + 1_000]);
    expect(pages.map((page) => page.fills.map((fill) => fill.tid))).toEqual([
      [1],
      [],
      [3],
    ]);
    expect(lagWaits).toEqual([
      [START + 1_000, START + 3_000],
      [START + 1_000, START + 3_000],
    ]);
    expect(pages.some((page) => page.isLagging)).toBe(false);
  });

  it('reads once when the start already covers the target', async () => {
    const { client, requests } = createClient([[]]);
    const pages = await collect(
      readFillsSince(client, WALLET, START, {
        readTargetTime: () => START - 60_000,
      }),
    );
    expect(requests).toEqual([START]);
    expect(pages).toHaveLength(1);
  });

  it('gives up after the lag limit and marks the last page lagging', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const client = {
      userFillsByTime: vi.fn(() => {
        vi.setSystemTime(Date.now() + 50_000);
        return Promise.resolve([] as HyperliquidFill[]);
      }),
    };
    const pages = await collect(
      readFillsSince(client, WALLET, START, {
        readTargetTime: () => START + 10_000,
      }),
    );
    expect(client.userFillsByTime).toHaveBeenCalledTimes(4);
    expect(pages.map((page) => page.isLagging)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(pages[3].receivedAt - pages[0].receivedAt).toBeGreaterThanOrEqual(
      BACKFILL_LAG_LIMIT_MS,
    );
  });

  it('starts the next page at the last fill time and drops fills it already sent', async () => {
    const boundary = START + 5_000;
    const firstPage = createFills(1, 2_000, (index) =>
      index >= 1_997 ? boundary : START + index,
    );
    const repeated = firstPage.slice(-3);
    const secondPage = [
      ...repeated,
      ...createFills(5_000, 500, (index) => boundary + 1 + index),
    ];
    const { client, requests } = createClient([firstPage, secondPage]);
    const pages = await collect(readFillsSince(client, WALLET, START));
    expect(requests).toEqual([START, boundary]);
    expect(pages.map((page) => page.fills.length)).toEqual([2_000, 500]);
    expect(pages[1].fills[0].tid).toBe(5_000);
    expect(pages.map((page) => page.nextStartTime)).toEqual([
      boundary,
      boundary + 500,
    ]);
    expect(pages.every((page) => !page.isTruncated)).toBe(true);
  });

  it('stops at a full page that adds no new tid', async () => {
    const sameMillisecond = createFills(1, 2_000, () => START);
    const { client, requests } = createClient([
      sameMillisecond,
      [...sameMillisecond],
    ]);
    const pages = await collect(readFillsSince(client, WALLET, START));
    expect(requests).toEqual([START, START]);
    expect(pages.map((page) => page.fills.length)).toEqual([2_000, 0]);
  });

  it('stops at a short page', async () => {
    const { client, requests } = createClient([
      createFills(1, 12, (index) => START + index),
    ]);
    const pages = await collect(readFillsSince(client, WALLET, START));
    expect(requests).toEqual([START]);
    expect(pages).toHaveLength(1);
    expect(pages[0].nextStartTime).toBe(START + 11);
  });

  it('keeps the cursor on an empty page', async () => {
    const { client } = createClient([[]]);
    const pages = await collect(readFillsSince(client, WALLET, START));
    expect(pages).toEqual([
      {
        fills: [],
        nextStartTime: START,
        isTruncated: false,
        isLagging: false,
        receivedAt: expect.any(Number) as number,
      },
    ]);
  });

  it('reports truncation once five full pages were read', async () => {
    const fullPages = Array.from({ length: 5 }, (_, page) =>
      createFills(
        page * 2_000 + 1,
        2_000,
        (index) => START + page * 10_000 + index,
      ),
    );
    const { client } = createClient([
      ...fullPages,
      createFills(20_000, 10, (index) => START + 60_000 + index),
    ]);
    const pages = await collect(readFillsSince(client, WALLET, START));
    expect(pages.map((page) => page.isTruncated)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it('retries a failed page with the reconnect backoff until it succeeds', async () => {
    const retries: number[] = [];
    const { client, requests } = createClient([
      new Error('status 502'),
      new Error('fetch failed'),
      createFills(1, 3, (index) => START + index),
    ]);
    const pages = await collect(
      readFillsSince(client, WALLET, START, {
        onRetry: (_error, attempt) => retries.push(attempt),
      }),
    );
    expect(requests).toEqual([START, START, START]);
    expect(retries).toEqual([1, 2]);
    expect(vi.mocked(reconnectDelayMs).mock.calls).toEqual([[0], [1]]);
    expect(pages[0].fills).toHaveLength(3);
  });

  it('ends without another page once aborted', async () => {
    const controller = new AbortController();
    const { client, requests } = createClient([
      createFills(1, 2_000, (index) => START + index),
      new Error('status 502'),
    ]);
    const pages: FillPage[] = [];
    for await (const page of readFillsSince(client, WALLET, START, {
      signal: controller.signal,
      onRetry: () => controller.abort(),
    })) {
      pages.push(page);
    }
    expect(pages).toHaveLength(1);
    expect(requests).toHaveLength(2);
  });
});
