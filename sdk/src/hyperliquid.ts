import type { Decimal } from "./types.js";

export type HyperliquidSubscriptionMethod = "subscribe" | "unsubscribe";
export type HyperliquidTrackedSubscriptionType =
  | "userFills"
  | "clearinghouseState";

export type HyperliquidTrackedSubscription =
  | {
      type: "userFills";
      user: string;
      aggregateByTime?: boolean;
    }
  | {
      type: "clearinghouseState";
      user: string;
      dex?: string;
    };

export type HyperliquidSubscriptionMessage = {
  method: HyperliquidSubscriptionMethod;
  subscription: HyperliquidTrackedSubscription;
};

export type HyperliquidWsFillSide = "A" | "B";
export type HyperliquidWsFillDirection =
  | "Open Long"
  | "Close Long"
  | "Open Short"
  | "Close Short"
  | string;

export type HyperliquidFillLiquidation = {
  liquidatedUser?: string;
  markPx: number;
  method: "market" | "backstop";
};

export type HyperliquidWsFill = {
  coin: string;
  px: Decimal;
  sz: Decimal;
  side: HyperliquidWsFillSide;
  time: number;
  startPosition: Decimal;
  dir: HyperliquidWsFillDirection;
  closedPnl: Decimal;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: Decimal;
  tid: number;
  feeToken: string;
  liquidation?: HyperliquidFillLiquidation;
  builderFee?: Decimal;
  twapId?: number | null;
};

export type HyperliquidWsUserFillsData = {
  isSnapshot?: boolean;
  user: string;
  fills: HyperliquidWsFill[];
};

export type HyperliquidWsUserFillsEvent = {
  channel: "userFills";
  data: HyperliquidWsUserFillsData;
};

export type HyperliquidMarginSummary = {
  accountValue: Decimal;
  totalNtlPos: Decimal;
  totalRawUsd: Decimal;
  totalMarginUsed: Decimal;
};

export type HyperliquidCumFunding = {
  allTime: Decimal;
  sinceOpen: Decimal;
  sinceChange: Decimal;
};

export type HyperliquidLeverage = {
  type: "cross" | "isolated" | string;
  value: number;
};

export type HyperliquidAssetPosition = {
  type: "oneWay" | string;
  position: {
    coin: string;
    szi: Decimal;
    leverage: HyperliquidLeverage;
    entryPx: Decimal;
    positionValue: Decimal;
    unrealizedPnl: Decimal;
    returnOnEquity: Decimal;
    liquidationPx: Decimal;
    marginUsed: Decimal;
    maxLeverage: number;
    cumFunding: HyperliquidCumFunding;
  };
};

export type HyperliquidClearinghouseState = {
  marginSummary: HyperliquidMarginSummary;
  crossMarginSummary: HyperliquidMarginSummary;
  crossMaintenanceMarginUsed: Decimal;
  withdrawable: Decimal;
  assetPositions: HyperliquidAssetPosition[];
  time: number;
};

export type HyperliquidWsClearinghouseStateData = {
  dex: string;
  user: string;
  clearinghouseState: HyperliquidClearinghouseState;
};

export type HyperliquidWsClearinghouseStateEvent = {
  channel: "clearinghouseState";
  data: HyperliquidWsClearinghouseStateData;
};

export type HyperliquidTrackedWsEvent =
  | HyperliquidWsUserFillsEvent
  | HyperliquidWsClearinghouseStateEvent;
