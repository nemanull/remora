export type PositionType = "LONG" | "SHORT";
export type LeverageMode = "CROSS" | "ISOLATED";
export type PositionStatus =
  | "OPENING"
  | "OPEN"
  | "CLOSING"
  | "CLOSED"
  | "LIQUIDATED"
  | "ERROR";

// Decimal values are represented as base-10 strings to avoid floating point
// precision issues across JSON boundaries.
// Example: "0.5", "12000", "-1.2345"
export type Decimal = string;

export type Wallet = {
  wallet_id: string; // e.g. `${address}:${exchange}`
  address: string;

  profitability_score: Decimal; // 0.0000 to 1.0000, higher is more profitable

  first_timestamp: Date;
  last_timestamp: Date;

  is_personal: boolean;

  balance_snapshots: BalanceSnapshot[];
  positions: WalletPosition[];
};

export type BalanceSnapshot = {
  snapshot_id: string; // e.g. `${address}:${exchange}:${timestamp_ms}`
  wallet_id: string;

  // margin_summary (flattened)
  margin_account_value: Decimal;
  margin_total_ntl_pos: Decimal;
  margin_total_raw_usd: Decimal;
  margin_total_margin_used: Decimal;

  // cross_margin_summary (flattened)
  cross_account_value: Decimal;
  cross_total_ntl_pos: Decimal;
  cross_total_raw_usd: Decimal;
  cross_total_margin_used: Decimal;

  cross_maintenance_margin_used_usd: Decimal;
  withdrawable_usd: Decimal;

  timestamp: Date;
};

export type WalletPosition = {
  position_id: string; // e.g. `${address}:${market}:${opened_at_ms}`
  wallet_id: string;

  hash: string; // from userEvents
  address: string; // user address
  market: string; // market name, e.g. "HYPE:USDC-PERP"

  direction_type: PositionType;
  platform_specific_position_type: string; // oneWay/hedge on hyperliquid

  leverage_mode: LeverageMode;
  leverage_value: Decimal;
  leverage_max?: Decimal;

  open_fees_usd: Decimal;
  close_fees_usd?: Decimal;
  fee_token: string;

  opened_at: Date;
  closed_at?: Date;

  status: PositionStatus;

  // self-relation: personal position → tracked position it was copied from
  copied_from_id?: string;

  metrics?: PositionMetrics;
  internal_metrics?: PositionInternalMetrics;
};

export type PositionInternalMetrics = {
  position_id: string;
  position_reasonability_score?: Decimal; // 0.0000 to 1.0000, higher is more credible
  description?: string;
};

export type PositionMetrics = {
  position_id: string;

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
