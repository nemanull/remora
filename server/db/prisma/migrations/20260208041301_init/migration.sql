-- CreateEnum
CREATE TYPE "PositionType" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "LeverageMode" AS ENUM ('CROSS', 'ISOLATED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED', 'LIQUIDATED');

-- CreateTable
CREATE TABLE "Wallet" (
    "wallet_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "first_wallet_snapshot" TIMESTAMP(3) NOT NULL,
    "last_wallet_snapshot" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "snapshot_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "margin_account_value" DECIMAL(65,30) NOT NULL,
    "margin_total_ntl_pos" DECIMAL(65,30) NOT NULL,
    "margin_total_raw_usd" DECIMAL(65,30) NOT NULL,
    "margin_total_margin_used" DECIMAL(65,30) NOT NULL,
    "cross_account_value" DECIMAL(65,30) NOT NULL,
    "cross_total_ntl_pos" DECIMAL(65,30) NOT NULL,
    "cross_total_raw_usd" DECIMAL(65,30) NOT NULL,
    "cross_total_margin_used" DECIMAL(65,30) NOT NULL,
    "cross_maintenance_margin_used_usd" DECIMAL(65,30) NOT NULL,
    "withdrawable_usd" DECIMAL(65,30) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BalanceSnapshot_pkey" PRIMARY KEY ("snapshot_id")
);

-- CreateTable
CREATE TABLE "WalletPosition" (
    "position_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "direction_type" "PositionType" NOT NULL,
    "platform_specific_position_type" TEXT NOT NULL,
    "leverage_mode" "LeverageMode" NOT NULL,
    "leverage_value" DECIMAL(65,30) NOT NULL,
    "leverage_max" DECIMAL(65,30),
    "opened_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "status" "PositionStatus" NOT NULL,

    CONSTRAINT "WalletPosition_pkey" PRIMARY KEY ("position_id")
);

-- CreateTable
CREATE TABLE "PositionMetrics" (
    "position_id" TEXT NOT NULL,
    "asset_size" DECIMAL(65,30) NOT NULL,
    "position_value_usd" DECIMAL(65,30) NOT NULL,
    "entry_asset_price_usd" DECIMAL(65,30) NOT NULL,
    "liquidation_asset_price_usd" DECIMAL(65,30) NOT NULL,
    "unrealized_pnl_usd" DECIMAL(65,30) NOT NULL,
    "realized_pnl_usd" DECIMAL(65,30) NOT NULL,
    "position_roi_percentage" DECIMAL(65,30) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PositionMetrics_pkey" PRIMARY KEY ("position_id")
);

-- CreateIndex
CREATE INDEX "Wallet_address_idx" ON "Wallet"("address");

-- CreateIndex
CREATE INDEX "BalanceSnapshot_wallet_id_timestamp_idx" ON "BalanceSnapshot"("wallet_id", "timestamp");

-- CreateIndex
CREATE INDEX "WalletPosition_wallet_id_status_idx" ON "WalletPosition"("wallet_id", "status");

-- CreateIndex
CREATE INDEX "WalletPosition_market_idx" ON "WalletPosition"("market");

-- CreateIndex
CREATE INDEX "WalletPosition_address_idx" ON "WalletPosition"("address");

-- AddForeignKey
ALTER TABLE "BalanceSnapshot" ADD CONSTRAINT "BalanceSnapshot_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "Wallet"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletPosition" ADD CONSTRAINT "WalletPosition_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "Wallet"("wallet_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionMetrics" ADD CONSTRAINT "PositionMetrics_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "WalletPosition"("position_id") ON DELETE CASCADE ON UPDATE CASCADE;
