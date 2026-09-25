export type DecimalString = string;

export type HyperliquidNetwork = 'mainnet' | 'testnet';

export const HYPERLIQUID_URLS = {
  mainnet: {
    apiUrl: 'https://api.hyperliquid.xyz',
    wsUrl: 'wss://api.hyperliquid.xyz/ws',
  },
  testnet: {
    apiUrl: 'https://api.hyperliquid-testnet.xyz',
    wsUrl: 'wss://api.hyperliquid-testnet.xyz/ws',
  },
} as const satisfies Record<
  HyperliquidNetwork,
  { apiUrl: string; wsUrl: string }
>;

export const STATS_DATA_URL = 'https://stats-data.hyperliquid.xyz/Mainnet';

export type HyperliquidSubscriptionMethod = 'subscribe' | 'unsubscribe';

export type HyperliquidSubscription =
  | {
      type: 'userFills';
      user: string;
      aggregateByTime?: boolean;
    }
  | {
      type: 'clearinghouseState';
      user: string;
      dex?: string;
    }
  | {
      type: 'allMids';
      dex?: string;
    };

export type HyperliquidSubscriptionMessage = {
  method: HyperliquidSubscriptionMethod;
  subscription: HyperliquidSubscription;
};

export type HyperliquidPingMessage = { method: 'ping' };

export type HyperliquidFillSide = 'A' | 'B';

export type HyperliquidFillLiquidation = {
  liquidatedUser?: string;
  markPx: DecimalString | number;
  method: 'market' | 'backstop';
};

export type HyperliquidFill = {
  coin: string;
  px: DecimalString;
  sz: DecimalString;
  side: HyperliquidFillSide;
  time: number;
  startPosition: DecimalString;
  dir: string;
  closedPnl: DecimalString;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: DecimalString;
  tid: number;
  feeToken: string;
  twapId: number | null;
  cloid?: string;
  builderFee?: DecimalString;
  liquidation?: HyperliquidFillLiquidation;
};

export type HyperliquidUserFillsData = {
  isSnapshot?: true;
  user: string;
  fills: HyperliquidFill[];
};

export type HyperliquidMarginSummary = {
  accountValue: DecimalString;
  totalNtlPos: DecimalString;
  totalRawUsd: DecimalString;
  totalMarginUsed: DecimalString;
};

export type HyperliquidLeverage = {
  type: 'cross' | 'isolated';
  value: number;
  rawUsd?: DecimalString;
};

export type HyperliquidCumulativeFunding = {
  allTime: DecimalString;
  sinceOpen: DecimalString;
  sinceChange: DecimalString;
};

export type HyperliquidPosition = {
  coin: string;
  szi: DecimalString;
  leverage: HyperliquidLeverage;
  entryPx: DecimalString;
  positionValue: DecimalString;
  unrealizedPnl: DecimalString;
  returnOnEquity: DecimalString;
  liquidationPx: DecimalString | null;
  marginUsed: DecimalString;
  maxLeverage: number;
  cumFunding: HyperliquidCumulativeFunding;
};

export type HyperliquidAssetPosition = {
  type: 'oneWay';
  position: HyperliquidPosition;
};

export type HyperliquidClearinghouseState = {
  marginSummary: HyperliquidMarginSummary;
  crossMarginSummary: HyperliquidMarginSummary;
  crossMaintenanceMarginUsed: DecimalString;
  withdrawable: DecimalString;
  assetPositions: HyperliquidAssetPosition[];
  time: number;
};

export type HyperliquidClearinghouseStateData = {
  dex: string;
  user: string;
  clearinghouseState: HyperliquidClearinghouseState;
};

export type HyperliquidAllMidsData = {
  mids: Record<string, DecimalString>;
};

export type HyperliquidUserFillsFrame = {
  channel: 'userFills';
  data: HyperliquidUserFillsData;
};

export type HyperliquidClearinghouseStateFrame = {
  channel: 'clearinghouseState';
  data: HyperliquidClearinghouseStateData;
};

export type HyperliquidAllMidsFrame = {
  channel: 'allMids';
  data: HyperliquidAllMidsData;
};

export type HyperliquidSubscriptionResponseFrame = {
  channel: 'subscriptionResponse';
  data: HyperliquidSubscriptionMessage;
};

export type HyperliquidErrorFrame = {
  channel: 'error';
  data: string;
};

export type HyperliquidPongFrame = {
  channel: 'pong';
};

export type HyperliquidWsFrame = {
  channel: string;
  data?: unknown;
};

export type PortfolioWindow =
  | 'day'
  | 'week'
  | 'month'
  | 'allTime'
  | 'perpDay'
  | 'perpWeek'
  | 'perpMonth'
  | 'perpAllTime';

export type PortfolioHistoryPoint = [time: number, value: DecimalString];

export type PortfolioPeriod = {
  accountValueHistory: PortfolioHistoryPoint[];
  pnlHistory: PortfolioHistoryPoint[];
  vlm: DecimalString;
};

export type PortfolioResponse = [PortfolioWindow, PortfolioPeriod][];

export type L2BookLevel = {
  px: DecimalString;
  sz: DecimalString;
  n: number;
};

export type L2BookResponse = {
  coin: string;
  time: number;
  levels: [bids: L2BookLevel[], asks: L2BookLevel[]];
};

export type PerpMarginMode = 'strictIsolated' | 'noCross';

export type PerpAsset = {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  marginTableId?: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
  marginMode?: PerpMarginMode;
};

export type PerpMeta = {
  universe: PerpAsset[];
};

export type PerpAssetContext = {
  funding: DecimalString;
  openInterest: DecimalString;
  prevDayPx: DecimalString;
  dayNtlVlm: DecimalString;
  premium: DecimalString | null;
  oraclePx: DecimalString;
  markPx: DecimalString;
  midPx: DecimalString | null;
  impactPxs: DecimalString[] | null;
  dayBaseVlm: DecimalString;
};

export type MetaAndAssetCtxs = [meta: PerpMeta, contexts: PerpAssetContext[]];

export type CandleInterval =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '8h'
  | '12h'
  | '1d'
  | '3d'
  | '1w'
  | '1M';

export type Candle = {
  t: number;
  T: number;
  s: string;
  i: CandleInterval;
  o: DecimalString;
  c: DecimalString;
  h: DecimalString;
  l: DecimalString;
  v: DecimalString;
  n: number;
};

export type FundingHistoryItem = {
  coin: string;
  fundingRate: DecimalString;
  premium: DecimalString;
  time: number;
};

export type NonFundingLedgerDeltaType =
  | 'deposit'
  | 'withdraw'
  | 'internalTransfer'
  | 'subAccountTransfer'
  | 'liquidation'
  | 'vaultCreate'
  | 'vaultDeposit'
  | 'vaultDistribution'
  | 'vaultWithdraw'
  | 'vaultLeaderCommission'
  | 'spotTransfer'
  | 'accountClassTransfer'
  | 'spotGenesis'
  | 'rewardsClaim';

export type NonFundingLedgerUpdate = {
  time: number;
  hash: string;
  delta: {
    type: NonFundingLedgerDeltaType;
    usdc?: DecimalString;
  };
};

export type HyperliquidOrderStatus =
  | 'open'
  | 'filled'
  | 'canceled'
  | 'triggered'
  | 'rejected'
  | 'marginCanceled'
  | 'vaultWithdrawalCanceled'
  | 'openInterestCapCanceled'
  | 'selfTradeCanceled'
  | 'reduceOnlyCanceled'
  | 'siblingFilledCanceled'
  | 'delistedCanceled'
  | 'liquidatedCanceled'
  | 'scheduledCancel'
  | 'tickRejected'
  | 'minTradeNtlRejected'
  | 'perpMarginRejected'
  | 'reduceOnlyRejected'
  | 'badAloPxRejected'
  | 'iocCancelRejected'
  | 'badTriggerPxRejected'
  | 'marketOrderNoLiquidityRejected'
  | 'positionIncreaseAtOpenInterestCapRejected'
  | 'positionFlipAtOpenInterestCapRejected'
  | 'tooAggressiveAtOpenInterestCapRejected'
  | 'openInterestIncreaseRejected'
  | 'insufficientSpotBalanceRejected'
  | 'oracleRejected'
  | 'perpMaxPositionRejected';

export type HyperliquidOrder = {
  coin: string;
  side: HyperliquidFillSide;
  limitPx: DecimalString;
  sz: DecimalString;
  oid: number;
  timestamp: number;
  triggerCondition: string;
  isTrigger: boolean;
  triggerPx: DecimalString;
  children: unknown[];
  isPositionTpsl: boolean;
  reduceOnly: boolean;
  orderType: string;
  origSz: DecimalString;
  tif: string | null;
  cloid: string | null;
};

export type OrderStatusResponse =
  | {
      status: 'order';
      order: {
        order: HyperliquidOrder;
        status: HyperliquidOrderStatus;
        statusTimestamp: number;
      };
    }
  | { status: 'unknownOid' };

export type UserAbstraction =
  | 'unifiedAccount'
  | 'portfolioMargin'
  | 'disabled'
  | 'default'
  | 'dexAbstraction';

export type UserRoleResponse =
  | { role: 'user' }
  | { role: 'agent'; data: { user: string } }
  | { role: 'vault' }
  | { role: 'subAccount'; data: { master: string } }
  | { role: 'missing' };
