export type Position_Type = "LONG" | "SHORT";
export type LeverageMode = "CROSS" | "ISOLATED";
export type PositionStatus = "OPEN" | "CLOSED" | "LIQUIDATED";

// Decimal values are represented as base-10 strings to avoid floating point
// precision issues across JSON boundaries.
// Example: "0.5", "12000", "-1.2345"
export type Decimal = string;

export type MarginSummary = {
  accountValue: Decimal;
  totalNtlPos: Decimal;
  totalRawUsd: Decimal;
  totalMarginUsed: Decimal;
};

export type FundingCumulative = {
  allTime: Decimal;
  sinceOpen: Decimal;
  sinceChange: Decimal;
};

export type Wallet = {
  wallet_id: string; // e.g. `${address}:${exchange}`
  address: string;

  profitability_score: Decimal; // 0.0000 to 1.0000, higher is more profitable

  first_timestamp: Date;
  last_timestamp: Date;

  balance_snapshots: BalanceSnapshot[];

  // positions
  wallet_positions: WalletPosition[];
};

export type BalanceSnapshot = {
  snapshot_id: string; // e.g. `${address}:${exchange}:${timestamp_ms}`

  margin_summary: MarginSummary;
  cross_margin_summary: MarginSummary;

  cross_maintenance_margin_used_usd: Decimal;
  withdrawable_usd: Decimal;

  timestamp: Date;
}


export type WalletPosition = {
  position_id: string; // e.g. `${address}:${market}:${opened_at_ms}`

  hash: string; // from userEvents
  address: string; // user address
  market: string; // market name, e.g. "HYPE:USDC-PERP"

  direction_type: Position_Type;
  platform_specific_position_type: string; // oneWay and hedge on hyperliquid

  leverage_mode: LeverageMode;
  leverage_value: Decimal;
  leverage_max?: Decimal;

  open_fees_usd: Decimal;
  close_fees_usd?: Decimal;
  fee_token: string;

  opened_at: Date;
  closed_at?: Date;

  metrics: PositionMetricsSnapshot;
  internal_metrics: PositionInternalMetrics;

  status: PositionStatus;
};

export type PositionInternalMetrics = {
  position_copied: string | false; // an id that I opened based on this one or just false if it wasn't copied
  position_reasonability_score?: Decimal; // 0.0000 to 1.0000, higher is more credible
  description?: string; 
}

export type PositionMetricsSnapshot = {
  // Position size in quote/base currency (platform-dependent), e.g. 200 HYPE
  asset_size: Decimal;
  // Position value in USD, e.g. 12000 USDC
  position_value_usd: Decimal;

  // If the position can be scaled in/out, this is typically the current avg entry.
  entry_asset_price_usd: Decimal;
  liquidation_asset_price_usd: Decimal;

  unrealized_pnl_usd: Decimal;
  realized_pnl_usd: Decimal;

  position_roi_percentage: Decimal;

  timestamp: Date;
};
