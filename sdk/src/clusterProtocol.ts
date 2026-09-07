import { z } from 'zod';
import type {
  HyperliquidClearinghouseStateData,
  HyperliquidFill,
  HyperliquidUserFillsData,
  PortfolioResponse,
} from './hyperliquid.js';

export const PROTOCOL_VERSION = 1;

export const CLUSTER_CLOSE_CODES = {
  protocol_error: 4000,
  replaced: 4001,
  storage_unavailable: 4005,
} as const;

export type ClusterCloseReason = keyof typeof CLUSTER_CLOSE_CODES;

export type ClusterEventChannel =
  | 'userFills'
  | 'clearinghouseState'
  | 'portfolio';
export type ClusterEventSource = 'stream' | 'snapshot' | 'backfill' | 'poll';
export type UpstreamState = 'connecting' | 'open' | 'closed';
export type BackfillState =
  | 'pending'
  | 'running'
  | 'retrying'
  | 'synced'
  | 'truncated'
  | 'lagging';

export type HelloMessage = {
  type: 'hello';
  protocolVersion: number;
  clusterId: number;
  sessionId: string;
  maxWallets: number;
  version: string;
};

export type WalletAssignment = {
  address: string;
  fillsSince: number;
};

export type AssignMessage = {
  type: 'assign';
  version: number;
  wallets: WalletAssignment[];
};

export type FailedWallet = {
  address: string;
  reason: string;
};

export type AssignedMessage = {
  type: 'assigned';
  version: number;
  subscribed: string[];
  failed: FailedWallet[];
};

export type EventMessage = {
  type: 'event';
  wallet: string;
  receivedAt: number;
} & (
  | {
      channel: 'userFills';
      source: 'stream' | 'snapshot';
      payload: HyperliquidUserFillsData;
    }
  | {
      channel: 'userFills';
      source: 'backfill';
      payload: HyperliquidFill[];
    }
  | {
      channel: 'clearinghouseState';
      source: 'stream';
      payload: HyperliquidClearinghouseStateData;
    }
  | {
      channel: 'portfolio';
      source: 'poll';
      payload: PortfolioResponse;
    }
);

export type SyncStartedMessage = {
  type: 'syncStarted';
  wallets: string[];
};

export type SyncedMessage = {
  type: 'synced';
  wallet: string;
};

export type CollectorWalletStats = {
  address: string;
  subscribedAt: number | null;
  lastEventAt: number | null;
  backfill: BackfillState;
};

export type CollectorStats = {
  upstreamState: UpstreamState;
  upstreamConnectedAt: number | null;
  upstreamReconnects: number;
  pingRoundTripMs: number | null;
  clockOffsetMs: number | null;
  eventLoopDelayP99Ms: number | null;
  rssBytes: number;
  weightUsedLastMinute: number;
  wallets: CollectorWalletStats[];
};

export type HeartbeatMessage = {
  type: 'heartbeat';
  sentAt: number;
  stats: CollectorStats;
};

export type HeartbeatAckMessage = {
  type: 'heartbeatAck';
  sentAt: number;
  serverTime: number;
};

export type CollectorMessage =
  | HelloMessage
  | AssignedMessage
  | EventMessage
  | SyncStartedMessage
  | SyncedMessage
  | HeartbeatMessage;

export type CoreMessage = AssignMessage | HeartbeatAckMessage;

export type ParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; reason: string };

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

const decimalString = z.string().regex(DECIMAL_PATTERN);
const timestamp = z.number().int().nonnegative();
const address = z.string().regex(ADDRESS_PATTERN);
const count = z.number().int().nonnegative();

const fillSchema: z.ZodType<HyperliquidFill> = z.object({
  coin: z.string().min(1),
  px: decimalString,
  sz: decimalString,
  side: z.enum(['A', 'B']),
  time: timestamp,
  startPosition: decimalString,
  dir: z.string(),
  closedPnl: decimalString,
  hash: z.string(),
  oid: count,
  crossed: z.boolean(),
  fee: decimalString,
  tid: count,
  feeToken: z.string(),
  twapId: z.number().int().nullable().default(null),
  cloid: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
  builderFee: decimalString.nullish().transform((value) => value ?? undefined),
  liquidation: z
    .object({
      liquidatedUser: z.string().optional(),
      markPx: z.union([decimalString, z.number()]),
      method: z.enum(['market', 'backstop']),
    })
    .optional(),
});

const userFillsDataSchema: z.ZodType<HyperliquidUserFillsData> = z.object({
  isSnapshot: z
    .boolean()
    .optional()
    .transform((value) => (value === true ? (true as const) : undefined)),
  user: z.string(),
  fills: z.array(fillSchema),
});

const marginSummarySchema = z.object({
  accountValue: decimalString,
  totalNtlPos: decimalString,
  totalRawUsd: decimalString,
  totalMarginUsed: decimalString,
});

const clearinghouseStateDataSchema: z.ZodType<HyperliquidClearinghouseStateData> =
  z.object({
    dex: z.string(),
    user: z.string(),
    clearinghouseState: z.object({
      marginSummary: marginSummarySchema,
      crossMarginSummary: marginSummarySchema,
      crossMaintenanceMarginUsed: decimalString,
      withdrawable: decimalString,
      assetPositions: z.array(
        z.object({
          type: z.literal('oneWay'),
          position: z.object({
            coin: z.string().min(1),
            szi: decimalString,
            leverage: z.object({
              type: z.enum(['cross', 'isolated']),
              value: z.number(),
              rawUsd: decimalString.optional(),
            }),
            entryPx: decimalString,
            positionValue: decimalString,
            unrealizedPnl: decimalString,
            returnOnEquity: decimalString,
            liquidationPx: decimalString.nullable(),
            marginUsed: decimalString,
            maxLeverage: z.number(),
            cumFunding: z.object({
              allTime: decimalString,
              sinceOpen: decimalString,
              sinceChange: decimalString,
            }),
          }),
        }),
      ),
      time: timestamp,
    }),
  });

const portfolioPointSchema = z.tuple([timestamp, decimalString]);

const portfolioSchema: z.ZodType<PortfolioResponse> = z.array(
  z.tuple([
    z.enum([
      'day',
      'week',
      'month',
      'allTime',
      'perpDay',
      'perpWeek',
      'perpMonth',
      'perpAllTime',
    ]),
    z.object({
      accountValueHistory: z.array(portfolioPointSchema),
      pnlHistory: z.array(portfolioPointSchema),
      vlm: decimalString,
    }),
  ]),
);

const helloSchema: z.ZodType<HelloMessage> = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int().positive(),
  clusterId: z.number().int().positive(),
  sessionId: z.uuid(),
  maxWallets: z.number().int().positive(),
  version: z.string().min(1),
});

const assignSchema: z.ZodType<AssignMessage> = z.object({
  type: z.literal('assign'),
  version: count,
  wallets: z.array(z.object({ address, fillsSince: timestamp })),
});

const assignedSchema: z.ZodType<AssignedMessage> = z.object({
  type: z.literal('assigned'),
  version: count,
  subscribed: z.array(address),
  failed: z.array(z.object({ address, reason: z.string().min(1) })),
});

const eventEnvelopeSchema = z.object({
  type: z.literal('event'),
  wallet: address,
  channel: z.enum(['userFills', 'clearinghouseState', 'portfolio']),
  source: z.enum(['stream', 'snapshot', 'backfill', 'poll']),
  receivedAt: timestamp,
  payload: z.unknown(),
});

const syncStartedSchema: z.ZodType<SyncStartedMessage> = z.object({
  type: z.literal('syncStarted'),
  wallets: z.array(address),
});

const syncedSchema: z.ZodType<SyncedMessage> = z.object({
  type: z.literal('synced'),
  wallet: address,
});

const collectorStatsSchema: z.ZodType<CollectorStats> = z.object({
  upstreamState: z.enum(['connecting', 'open', 'closed']),
  upstreamConnectedAt: timestamp.nullable(),
  upstreamReconnects: count,
  pingRoundTripMs: z.number().nonnegative().nullable(),
  clockOffsetMs: z.number().nullable(),
  eventLoopDelayP99Ms: z.number().nonnegative().nullable(),
  rssBytes: count,
  weightUsedLastMinute: z.number().nonnegative(),
  wallets: z.array(
    z.object({
      address,
      subscribedAt: timestamp.nullable(),
      lastEventAt: timestamp.nullable(),
      backfill: z.enum([
        'pending',
        'running',
        'retrying',
        'synced',
        'truncated',
        'lagging',
      ]),
    }),
  ),
});

const heartbeatSchema: z.ZodType<HeartbeatMessage> = z.object({
  type: z.literal('heartbeat'),
  sentAt: timestamp,
  stats: collectorStatsSchema,
});

const heartbeatAckSchema: z.ZodType<HeartbeatAckMessage> = z.object({
  type: z.literal('heartbeatAck'),
  sentAt: timestamp,
  serverTime: timestamp,
});

function describeFailure(subject: string, error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'value';
  return `invalid ${subject}: ${path} ${issue?.message ?? 'is invalid'}`;
}

function parseWith<T>(
  schema: z.ZodType<T>,
  value: unknown,
  subject: string,
): ParseResult<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    return { ok: false, reason: describeFailure(subject, result.error) };
  }
  return { ok: true, message: result.data };
}

function checkPayloadUser(
  wallet: string,
  user: string,
): ParseResult<never> | null {
  if (user.toLowerCase() === wallet) {
    return null;
  }
  return {
    ok: false,
    reason: `event wallet ${wallet} does not match payload user ${user}`,
  };
}

export function parseHello(value: unknown): ParseResult<HelloMessage> {
  return parseWith(helloSchema, value, 'hello');
}

export function parseAssign(value: unknown): ParseResult<AssignMessage> {
  return parseWith(assignSchema, value, 'assign');
}

export function parseAssigned(value: unknown): ParseResult<AssignedMessage> {
  return parseWith(assignedSchema, value, 'assigned');
}

export function parseEvent(value: unknown): ParseResult<EventMessage> {
  const envelope = eventEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return { ok: false, reason: describeFailure('event', envelope.error) };
  }
  const { wallet, channel, source, receivedAt, payload } = envelope.data;
  if (
    channel === 'userFills' &&
    (source === 'stream' || source === 'snapshot')
  ) {
    const parsed = parseWith(userFillsDataSchema, payload, 'userFills payload');
    if (!parsed.ok) {
      return parsed;
    }
    const mismatch = checkPayloadUser(wallet, parsed.message.user);
    if (mismatch) {
      return mismatch;
    }
    return {
      ok: true,
      message: {
        type: 'event',
        wallet,
        channel,
        source,
        receivedAt,
        payload: parsed.message,
      },
    };
  }
  if (channel === 'userFills' && source === 'backfill') {
    const parsed = parseWith(z.array(fillSchema), payload, 'backfill payload');
    if (!parsed.ok) {
      return parsed;
    }
    return {
      ok: true,
      message: {
        type: 'event',
        wallet,
        channel,
        source,
        receivedAt,
        payload: parsed.message,
      },
    };
  }
  if (channel === 'clearinghouseState' && source === 'stream') {
    const parsed = parseWith(
      clearinghouseStateDataSchema,
      payload,
      'clearinghouseState payload',
    );
    if (!parsed.ok) {
      return parsed;
    }
    const mismatch = checkPayloadUser(wallet, parsed.message.user);
    if (mismatch) {
      return mismatch;
    }
    return {
      ok: true,
      message: {
        type: 'event',
        wallet,
        channel,
        source,
        receivedAt,
        payload: parsed.message,
      },
    };
  }
  if (channel === 'portfolio' && source === 'poll') {
    const parsed = parseWith(portfolioSchema, payload, 'portfolio payload');
    if (!parsed.ok) {
      return parsed;
    }
    return {
      ok: true,
      message: {
        type: 'event',
        wallet,
        channel,
        source,
        receivedAt,
        payload: parsed.message,
      },
    };
  }
  return {
    ok: false,
    reason: `invalid event: channel ${channel} cannot come from source ${source}`,
  };
}

export function parseSyncStarted(
  value: unknown,
): ParseResult<SyncStartedMessage> {
  return parseWith(syncStartedSchema, value, 'syncStarted');
}

export function parseSynced(value: unknown): ParseResult<SyncedMessage> {
  return parseWith(syncedSchema, value, 'synced');
}

export function parseHeartbeat(value: unknown): ParseResult<HeartbeatMessage> {
  return parseWith(heartbeatSchema, value, 'heartbeat');
}

export function parseHeartbeatAck(
  value: unknown,
): ParseResult<HeartbeatAckMessage> {
  return parseWith(heartbeatAckSchema, value, 'heartbeatAck');
}

function decodeFrame(
  raw: string,
): { type: string | null; value: unknown } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const type =
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
      ? (value as { type: string }).type
      : null;
  return { type, value };
}

export function parseCollectorFrame(
  raw: string,
): ParseResult<CollectorMessage> {
  const frame = decodeFrame(raw);
  if (!frame) {
    return { ok: false, reason: 'frame is not valid JSON' };
  }
  switch (frame.type) {
    case 'hello':
      return parseHello(frame.value);
    case 'assigned':
      return parseAssigned(frame.value);
    case 'event':
      return parseEvent(frame.value);
    case 'syncStarted':
      return parseSyncStarted(frame.value);
    case 'synced':
      return parseSynced(frame.value);
    case 'heartbeat':
      return parseHeartbeat(frame.value);
    default:
      return {
        ok: false,
        reason: `unknown collector frame type ${frame.type}`,
      };
  }
}

export function parseCoreFrame(raw: string): ParseResult<CoreMessage> {
  const frame = decodeFrame(raw);
  if (!frame) {
    return { ok: false, reason: 'frame is not valid JSON' };
  }
  switch (frame.type) {
    case 'assign':
      return parseAssign(frame.value);
    case 'heartbeatAck':
      return parseHeartbeatAck(frame.value);
    default:
      return { ok: false, reason: `unknown core frame type ${frame.type}` };
  }
}
