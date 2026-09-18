import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import type { HyperliquidFill } from './hyperliquid.js';
import { HyperliquidInfoClient, RateLimitedError } from './infoClient.js';
import { WeightBudget } from './weightBudget.js';

const USER = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';

function fill(tid: number): HyperliquidFill {
  return {
    coin: 'BTC',
    px: '67012.5',
    sz: '0.01',
    side: 'B',
    time: 1_775_000_000_000 + tid,
    startPosition: '0.0',
    dir: 'Open Long',
    closedPnl: '0.0',
    hash: '0x0',
    oid: tid,
    crossed: true,
    fee: '0.3',
    tid,
    feeToken: 'USDC',
    twapId: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HyperliquidInfoClient', () => {
  let events: string[];
  let budget: WeightBudget;
  let fetchMock: Mock<typeof fetch>;
  let client: HyperliquidInfoClient;

  function answerWith(body: unknown, status = 200): void {
    fetchMock.mockImplementation((_url, init) => {
      const request = JSON.parse(init?.body as string) as { type: string };
      events.push(`fetch ${request.type}`);
      return Promise.resolve(jsonResponse(body, status));
    });
  }

  beforeEach(() => {
    events = [];
    budget = new WeightBudget(1_200);
    vi.spyOn(budget, 'take').mockImplementation((weight) => {
      events.push(`take ${weight}`);
      return Promise.resolve();
    });
    vi.spyOn(budget, 'charge').mockImplementation((weight) => {
      events.push(`charge ${weight}`);
    });
    vi.spyOn(budget, 'pauseFor').mockImplementation((ms) => {
      events.push(`pause ${ms}`);
    });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    client = new HyperliquidInfoClient('https://api.example.test/', budget);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('takes the base weight before the call and the fill surcharge after it', async () => {
    answerWith(Array.from({ length: 2_000 }, (_, index) => fill(index)));

    const fills = await client.userFillsByTime(USER, 0);

    expect(fills).toHaveLength(2_000);
    expect(events).toEqual(['take 20', 'fetch userFillsByTime', 'charge 100']);
  });

  it('charges the ledger updates like fills', async () => {
    answerWith(Array.from({ length: 45 }, () => ({})));

    await client.userNonFundingLedgerUpdates(USER, 0);

    expect(events).toEqual([
      'take 20',
      'fetch userNonFundingLedgerUpdates',
      'charge 2',
    ]);
  });

  it('charges nothing after a portfolio call', async () => {
    answerWith([]);

    await client.portfolio(USER);

    expect(events).toEqual(['take 20', 'fetch portfolio']);
  });

  it.each([
    ['clearinghouseState', () => client.clearinghouseState(USER), 2],
    ['l2Book', () => client.l2Book('BTC'), 2],
    [
      'orderStatus',
      () => client.orderStatus(USER, '0x1234567890abcdef1234567890abcdef'),
      2,
    ],
    ['metaAndAssetCtxs', () => client.metaAndAssetCtxs(), 20],
    ['userAbstraction', () => client.userAbstraction(USER), 20],
    ['userRole', () => client.userRole(USER), 60],
  ])('takes the documented weight for %s', async (type, call, weight) => {
    answerWith({});

    await call();

    expect(events).toEqual([`take ${weight}`, `fetch ${type}`]);
  });

  it('posts JSON to the info endpoint without undefined fields', async () => {
    answerWith([]);

    await client.userFillsByTime(USER, 1_775_000_000_000);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/info');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'userFillsByTime',
      user: USER,
      startTime: 1_775_000_000_000,
    });
  });

  it('pauses the budget for 60 s and throws on a 429', async () => {
    answerWith('rate limited', 429);

    await expect(client.userFillsByTime(USER, 0)).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(events).toEqual(['take 20', 'fetch userFillsByTime', 'pause 60000']);
  });

  it('throws with the status on any other failure', async () => {
    answerWith('Failed to deserialize the JSON body into the target type', 422);

    await expect(client.portfolio(USER)).rejects.toThrow(/status 422/);
  });
});
