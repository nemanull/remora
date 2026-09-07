import {
  reconnectDelayMs,
  type CollectorStats,
  type EventMessage,
  type HelloMessage,
} from '@remora/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { FakeCore, waitUntil } from '../test/fakeCore';
import { CoreLink, type CoreLinkOptions } from './coreLink';

vi.mock('@remora/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@remora/sdk')>()),
  reconnectDelayMs: vi.fn(() => 5),
}));

const TOKEN = 'collector-token-0123456789abcdef0123456789';
const WALLET = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';
const FAKE_TIMERS: (
  | 'setTimeout'
  | 'clearTimeout'
  | 'setInterval'
  | 'clearInterval'
  | 'Date'
)[] = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'];

const HELLO: HelloMessage = {
  type: 'hello',
  protocolVersion: 1,
  clusterId: 3,
  sessionId: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
  maxWallets: 8,
  version: '1.0.0',
};

function createStats(): CollectorStats {
  return {
    upstreamState: 'open',
    upstreamConnectedAt: null,
    upstreamReconnects: 0,
    pingRoundTripMs: null,
    clockOffsetMs: null,
    eventLoopDelayP99Ms: null,
    rssBytes: 1,
    weightUsedLastMinute: 0,
    wallets: [],
  };
}

function createEvent(index: number): EventMessage {
  return {
    type: 'event',
    wallet: WALLET,
    channel: 'userFills',
    source: 'backfill',
    receivedAt: index,
    payload: [],
  };
}

describe('CoreLink', () => {
  let core: FakeCore;
  let links: CoreLink[];
  let closes: string[];
  let opens: number;

  function createLink(options: Partial<CoreLinkOptions> = {}): CoreLink {
    const link = new CoreLink({
      url: core.url,
      token: TOKEN,
      createHello: () => HELLO,
      readStats: createStats,
      onOpen: () => {
        opens += 1;
      },
      onAssign: () => undefined,
      onClose: (reason) => closes.push(reason),
      onInvalidFrame: () => undefined,
      ...options,
    });
    links.push(link);
    return link;
  }

  beforeEach(async () => {
    core = await FakeCore.start({ token: TOKEN });
    links = [];
    closes = [];
    opens = 0;
    vi.mocked(reconnectDelayMs).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(links.map((link) => link.stop()));
    await core.close();
  });

  it('dials with the bearer token and sends hello as the first frame', async () => {
    const link = createLink();
    link.start();
    await core.waitForFrame((frame) => frame.type === 'hello');
    expect(core.frames[0]).toEqual(HELLO);
    expect(link.isOpen).toBe(true);
    expect(opens).toBe(1);
  });

  it('backs off and retries after the core answers 401', async () => {
    await core.close();
    core = await FakeCore.start({
      token: 'another-token-0123456789abcdef01234567',
    });
    const link = createLink();
    link.start();
    await waitUntil(() => closes.length >= 3, 5_000, 'three rejected dials');
    expect(closes[0]).toContain('401');
    expect(core.rejectedUpgrades).toBeGreaterThanOrEqual(3);
    expect(vi.mocked(reconnectDelayMs).mock.calls.slice(0, 3)).toEqual([
      [0],
      [1],
      [2],
    ]);
    expect(link.isOpen).toBe(false);
  });

  it('hands every assign over and reports frames that fail to parse', async () => {
    const assigns: number[] = [];
    const invalid: string[] = [];
    const link = createLink({
      onAssign: (assign) => assigns.push(assign.version),
      onInvalidFrame: (reason) => invalid.push(reason),
    });
    link.start();
    await core.waitForFrame((frame) => frame.type === 'hello');
    core.sendAssign([{ address: WALLET, fillsSince: 1_700_000_000_000 }]);
    core.currentSession?.send('{"type":"assign","version":-1}');
    await waitUntil(() => assigns.length === 1 && invalid.length === 1);
    expect(assigns).toEqual([1]);
    expect(invalid[0]).toContain('assign');
  });

  it('terminates the link after 30 seconds without a heartbeatAck', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    core.acknowledgesHeartbeats = false;
    const link = createLink();
    link.start();
    await core.waitForFrame((frame) => frame.type === 'hello');
    vi.advanceTimersByTime(29_999);
    await waitUntil(() => core.framesOf('heartbeat').length === 2);
    expect(closes).toEqual([]);
    vi.advanceTimersByTime(1);
    await waitUntil(() => closes.length === 1);
    expect(closes[0]).toContain('no heartbeatAck within 30000 ms');
    expect(link.isOpen).toBe(false);
  });

  it('sends a heartbeat every 10 seconds and derives the clock offset from each ack', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    core.serverTimeOffsetMs = 1_234;
    const link = createLink();
    link.start();
    await core.waitForFrame((frame) => frame.type === 'hello');
    expect(link.readClockOffsetMs()).toBeNull();
    vi.advanceTimersByTime(10_000);
    await waitUntil(() => link.readClockOffsetMs() !== null);
    expect(link.readClockOffsetMs()).toBe(1_234);
    expect(core.framesOf('heartbeat')).toHaveLength(1);
  });

  it('keeps a link alive while acks arrive and resets the backoff after a stable minute', async () => {
    vi.useFakeTimers({ toFake: FAKE_TIMERS });
    const link = createLink();
    link.start();
    for (let drop = 1; drop <= 2; drop += 1) {
      await waitUntil(() => opens === drop);
      core.dropSession();
      await waitUntil(() => closes.length === drop);
      vi.advanceTimersByTime(5);
    }
    await waitUntil(() => opens === 3);
    const heartbeatsBefore = core.framesOf('heartbeat').length;
    for (let beat = 1; beat <= 7; beat += 1) {
      vi.advanceTimersByTime(10_000);
      await waitUntil(
        () => core.framesOf('heartbeat').length === heartbeatsBefore + beat,
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(closes).toHaveLength(2);
    core.dropSession();
    await waitUntil(() => closes.length === 3);
    expect(vi.mocked(reconnectDelayMs).mock.calls).toEqual([[0], [1], [0]]);
    expect(link.isOpen).toBe(false);
  });

  it('delivers every message in order while open and drops them while closed', async () => {
    const link = createLink();
    expect(link.send(createEvent(0))).toBe(false);
    link.start();
    await core.waitForFrame((frame) => frame.type === 'hello');
    for (let index = 1; index <= 2_000; index += 1) {
      expect(link.send(createEvent(index))).toBe(true);
    }
    await waitUntil(() => core.framesOf('event').length === 2_000);
    expect(core.framesOf('event').map((event) => event.receivedAt)).toEqual(
      Array.from({ length: 2_000 }, (_, index) => index + 1),
    );
    core.dropSession();
    await waitUntil(() => closes.length === 1);
    expect(link.send(createEvent(2_001))).toBe(false);
  });

  it('closes the link instead of dropping once the send buffer passes 16 MB', async () => {
    const link = createLink();
    link.start();
    await core.waitForFrame((frame) => frame.type === 'hello');
    vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(
      16 * 1024 * 1024 + 1,
    );
    expect(link.send(createEvent(1))).toBe(true);
    expect(link.isOpen).toBe(false);
    expect(link.send(createEvent(2))).toBe(false);
    await waitUntil(() => closes.length === 1);
    expect(closes[0]).toContain('send buffer passed 16777216 bytes');
  });
});
