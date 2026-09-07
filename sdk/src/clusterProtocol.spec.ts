import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLUSTER_CLOSE_CODES,
  type CollectorStats,
  parseAssign,
  parseAssigned,
  parseCollectorFrame,
  parseCoreFrame,
  parseEvent,
  parseHeartbeat,
  parseHeartbeatAck,
  parseHello,
  parseSynced,
  parseSyncStarted,
  type ParseResult,
  PROTOCOL_VERSION,
} from './clusterProtocol.js';
import type {
  HyperliquidFill,
  HyperliquidUserFillsData,
} from './hyperliquid.js';

const WALLET = '0xc5fdde670e647823dbf07a09c452fe3f33df8677';
const OTHER_WALLET = '0x4e23288cee4960f9f962195c22948e4bc7ae20c3';
const RECEIVED_AT = 1_775_000_000_000;

function readPayload(path: string): {
  channel: string;
  data: Record<string, unknown>;
} {
  return JSON.parse(
    readFileSync(new URL(`../../payloads/${path}`, import.meta.url), 'utf8'),
  ) as { channel: string; data: Record<string, unknown> };
}

const userFillsSnapshot = readPayload('userFills/snapshot.json').data;
const clearinghouseState = readPayload(
  'clearinghouseState/account-positions.2.json',
).data;
const snapshotFills = userFillsSnapshot.fills as HyperliquidFill[];

function expectOk<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.message;
}

function expectFailure(result: ParseResult<unknown>): string {
  if (result.ok) {
    throw new Error('expected the frame to be rejected');
  }
  return result.reason;
}

function hello(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    clusterId: 1,
    sessionId: '0b0c51f4-5bd5-4cb5-9d1f-3c7a1f4e2a61',
    maxWallets: 8,
    version: '0.0.1',
    ...overrides,
  };
}

function event(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'event',
    wallet: WALLET,
    channel: 'userFills',
    source: 'stream',
    receivedAt: RECEIVED_AT,
    payload: userFillsSnapshot,
    ...overrides,
  };
}

function stats(overrides: Partial<CollectorStats> = {}): CollectorStats {
  return {
    upstreamState: 'open',
    upstreamConnectedAt: RECEIVED_AT - 60_000,
    upstreamReconnects: 2,
    pingRoundTripMs: 95,
    clockOffsetMs: -3.5,
    eventLoopDelayP99Ms: 12.4,
    rssBytes: 81_000_000,
    weightUsedLastMinute: 160,
    wallets: [
      {
        address: WALLET,
        subscribedAt: RECEIVED_AT - 55_000,
        lastEventAt: RECEIVED_AT - 1_000,
        backfill: 'synced',
      },
    ],
    ...overrides,
  };
}

function portfolio(): unknown {
  const period = {
    accountValueHistory: [
      [RECEIVED_AT - 86_400_000, '19.749115'],
      [RECEIVED_AT, '19.388906'],
    ],
    pnlHistory: [
      [RECEIVED_AT - 86_400_000, '0.0'],
      [RECEIVED_AT, '-0.411094'],
    ],
    vlm: '120.5',
  };
  return [
    'day',
    'week',
    'month',
    'allTime',
    'perpDay',
    'perpWeek',
    'perpMonth',
    'perpAllTime',
  ].map((window) => [window, period]);
}

describe('cluster protocol', () => {
  it('keeps the close codes 4000, 4001 and 4005', () => {
    expect(CLUSTER_CLOSE_CODES).toEqual({
      protocol_error: 4000,
      replaced: 4001,
      storage_unavailable: 4005,
    });
  });

  describe('parseHello', () => {
    it('accepts a valid hello', () => {
      expect(parseHello(hello())).toEqual({ ok: true, message: hello() });
    });

    it('rejects a session id that is not a UUID', () => {
      const reason = expectFailure(
        parseHello(hello({ sessionId: 'session-1' })),
      );

      expect(reason).toContain('sessionId');
    });

    it('rejects a missing cluster id with the field in the reason', () => {
      const frame = hello();
      delete frame.clusterId;

      expect(expectFailure(parseHello(frame))).toMatch(
        /^invalid hello: clusterId/,
      );
    });

    it('rejects a cluster id that is not a positive integer', () => {
      expect(parseHello(hello({ clusterId: 0 })).ok).toBe(false);
      expect(parseHello(hello({ clusterId: 1.5 })).ok).toBe(false);
    });
  });

  describe('parseAssign', () => {
    it('accepts the full watch list with backfill cursors', () => {
      const frame = {
        type: 'assign',
        version: 3,
        wallets: [{ address: WALLET, fillsSince: RECEIVED_AT }],
      };

      expect(parseAssign(frame)).toEqual({ ok: true, message: frame });
    });

    it('rejects an address that is not lowercase', () => {
      const frame = {
        type: 'assign',
        version: 3,
        wallets: [
          { address: WALLET.toUpperCase().replace('0X', '0x'), fillsSince: 0 },
        ],
      };

      expect(parseAssign(frame).ok).toBe(false);
    });
  });

  describe('parseAssigned', () => {
    it('accepts subscribed and failed wallets with their reasons', () => {
      const frame = {
        type: 'assigned',
        version: 3,
        subscribed: [WALLET],
        failed: [{ address: OTHER_WALLET, reason: 'user_limit' }],
      };

      expect(parseAssigned(frame)).toEqual({ ok: true, message: frame });
    });

    it('rejects a failure without a reason', () => {
      const frame = {
        type: 'assigned',
        version: 3,
        subscribed: [],
        failed: [{ address: OTHER_WALLET, reason: '' }],
      };

      expect(parseAssigned(frame).ok).toBe(false);
    });
  });

  describe('parseEvent', () => {
    it('accepts a userFills snapshot and keeps every fill', () => {
      const message = expectOk(parseEvent(event({ source: 'snapshot' })));
      const payload = message.payload as HyperliquidUserFillsData;

      expect(payload.isSnapshot).toBe(true);
      expect(payload.fills).toHaveLength(snapshotFills.length);
      expect(payload.fills[0]).toEqual(snapshotFills[0]);
    });

    it('treats isSnapshot false like a live frame', () => {
      const message = expectOk(
        parseEvent(
          event({ payload: { ...userFillsSnapshot, isSnapshot: false } }),
        ),
      );

      expect(
        (message.payload as HyperliquidUserFillsData).isSnapshot,
      ).toBeUndefined();
    });

    it('defaults a missing twapId to null', () => {
      const fillWithoutTwap: Partial<HyperliquidFill> = { ...snapshotFills[0] };
      delete fillWithoutTwap.twapId;

      const message = expectOk(
        parseEvent(
          event({ payload: { user: WALLET, fills: [fillWithoutTwap] } }),
        ),
      );

      expect(
        (message.payload as HyperliquidUserFillsData).fills[0].twapId,
      ).toBeNull();
    });

    it('accepts a liquidation whose mark price is a number', () => {
      const liquidated = {
        ...snapshotFills[0],
        liquidation: { markPx: 0.003, method: 'market' },
      };

      expect(
        parseEvent(event({ payload: { user: WALLET, fills: [liquidated] } }))
          .ok,
      ).toBe(true);
    });

    it('rejects a payload whose user is another wallet', () => {
      const result = parseEvent(event({ wallet: OTHER_WALLET }));

      expect(result).toEqual({
        ok: false,
        reason: `event wallet ${OTHER_WALLET} does not match payload user ${WALLET}`,
      });
    });

    it('rejects a fill price that is not a decimal', () => {
      const broken = { ...snapshotFills[0], px: 'NaN' };

      const reason = expectFailure(
        parseEvent(event({ payload: { user: WALLET, fills: [broken] } })),
      );

      expect(reason).toContain('fills.0.px');
    });

    it('accepts a backfill page as the raw fill array', () => {
      const message = expectOk(
        parseEvent(event({ source: 'backfill', payload: snapshotFills })),
      );

      expect(message.payload).toEqual(snapshotFills);
    });

    it('accepts a clearinghouseState push with a null liquidation price', () => {
      const state = clearinghouseState.clearinghouseState as {
        assetPositions: { position: Record<string, unknown> }[];
      };
      const payload = {
        ...clearinghouseState,
        clearinghouseState: {
          ...state,
          assetPositions: [
            {
              type: 'oneWay',
              position: {
                ...state.assetPositions[0].position,
                liquidationPx: null,
              },
            },
          ],
        },
      };

      expect(
        parseEvent(event({ channel: 'clearinghouseState', payload })).ok,
      ).toBe(true);
    });

    it('accepts a portfolio poll', () => {
      expect(
        parseEvent(
          event({ channel: 'portfolio', source: 'poll', payload: portfolio() }),
        ).ok,
      ).toBe(true);
    });

    it('rejects a channel and source pair the collector never sends', () => {
      const result = parseEvent(
        event({ channel: 'portfolio', source: 'stream', payload: portfolio() }),
      );

      expect(result).toEqual({
        ok: false,
        reason:
          'invalid event: channel portfolio cannot come from source stream',
      });
    });

    it('rejects an unknown channel', () => {
      expect(parseEvent(event({ channel: 'orderUpdates' })).ok).toBe(false);
    });
  });

  describe('sync messages', () => {
    it('accepts syncStarted with its wallets', () => {
      const frame = { type: 'syncStarted', wallets: [WALLET, OTHER_WALLET] };

      expect(parseSyncStarted(frame)).toEqual({ ok: true, message: frame });
    });

    it('accepts synced for one wallet', () => {
      expect(parseSynced({ type: 'synced', wallet: WALLET })).toEqual({
        ok: true,
        message: { type: 'synced', wallet: WALLET },
      });
    });

    it('rejects synced without a wallet', () => {
      expect(parseSynced({ type: 'synced' }).ok).toBe(false);
    });
  });

  describe('heartbeats', () => {
    it('accepts a heartbeat with complete stats', () => {
      const frame = { type: 'heartbeat', sentAt: RECEIVED_AT, stats: stats() };

      expect(parseHeartbeat(frame)).toEqual({ ok: true, message: frame });
    });

    it('accepts stats taken before the upstream socket ever opened', () => {
      const frame = {
        type: 'heartbeat',
        sentAt: RECEIVED_AT,
        stats: stats({
          upstreamState: 'connecting',
          upstreamConnectedAt: null,
          pingRoundTripMs: null,
          clockOffsetMs: null,
          eventLoopDelayP99Ms: null,
          wallets: [],
        }),
      };

      expect(parseHeartbeat(frame).ok).toBe(true);
    });

    it('accepts a wallet whose backfill gave up waiting for a lagging REST view', () => {
      const lagging = stats();
      const frame = {
        type: 'heartbeat',
        sentAt: RECEIVED_AT,
        stats: {
          ...lagging,
          wallets: [{ ...lagging.wallets[0], backfill: 'lagging' }],
        },
      };

      expect(parseHeartbeat(frame)).toEqual({ ok: true, message: frame });
    });

    it('rejects stats with an unknown backfill state', () => {
      const broken = stats();
      const frame = {
        type: 'heartbeat',
        sentAt: RECEIVED_AT,
        stats: {
          ...broken,
          wallets: [{ ...broken.wallets[0], backfill: 'stuck' }],
        },
      };

      expect(parseHeartbeat(frame).ok).toBe(false);
    });

    it('accepts a heartbeat acknowledgement', () => {
      const frame = {
        type: 'heartbeatAck',
        sentAt: RECEIVED_AT,
        serverTime: RECEIVED_AT + 40,
      };

      expect(parseHeartbeatAck(frame)).toEqual({ ok: true, message: frame });
    });
  });

  describe('frame dispatch', () => {
    it('parses a raw collector frame by its type', () => {
      const result = parseCollectorFrame(JSON.stringify(hello()));

      expect(result).toEqual({ ok: true, message: hello() });
    });

    it('rejects a frame that is not JSON', () => {
      expect(parseCollectorFrame('{"type":')).toEqual({
        ok: false,
        reason: 'frame is not valid JSON',
      });
    });

    it('rejects a collector frame of an unknown type', () => {
      expect(
        parseCollectorFrame(JSON.stringify({ type: 'walletEvent' })),
      ).toEqual({
        ok: false,
        reason: 'unknown collector frame type walletEvent',
      });
    });

    it('rejects a collector message sent to the collector', () => {
      expect(parseCoreFrame(JSON.stringify(hello()))).toEqual({
        ok: false,
        reason: 'unknown core frame type hello',
      });
    });

    it('parses a raw core frame by its type', () => {
      const frame = { type: 'heartbeatAck', sentAt: 1, serverTime: 2 };

      expect(parseCoreFrame(JSON.stringify(frame))).toEqual({
        ok: true,
        message: frame,
      });
    });
  });
});
