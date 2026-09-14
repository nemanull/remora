-- CreateEnum
CREATE TYPE "FillSource" AS ENUM ('STREAM', 'SNAPSHOT', 'BACKFILL');

-- CreateEnum
CREATE TYPE "CopyAction" AS ENUM ('OPEN', 'INCREASE', 'REDUCE', 'CLOSE', 'FLIP');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('COPY', 'SKIP');

-- CreateEnum
CREATE TYPE "OrderPurpose" AS ENUM ('ENTRY', 'EXIT', 'STOP', 'RECONCILE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'UNFILLED', 'REJECTED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "LeaderFill" (
    "id" BIGSERIAL NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "tid" BIGINT NOT NULL,
    "px" DECIMAL(30,10) NOT NULL,
    "sz" DECIMAL(30,10) NOT NULL,
    "side" TEXT NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL,
    "start_position" DECIMAL(30,10) NOT NULL,
    "dir" TEXT NOT NULL,
    "closed_pnl" DECIMAL(30,10) NOT NULL,
    "fee" DECIMAL(30,10) NOT NULL,
    "oid" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "crossed" BOOLEAN NOT NULL,
    "twap_id" BIGINT,
    "is_liquidation" BOOLEAN NOT NULL DEFAULT false,
    "source" "FillSource" NOT NULL,
    "cluster_id" INTEGER,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "ingested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signalled_at" TIMESTAMPTZ(3),

    CONSTRAINT "LeaderFill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyDecision" (
    "id" BIGSERIAL NOT NULL,
    "book" "Book" NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "signal_key" TEXT NOT NULL,
    "signal_source" TEXT NOT NULL,
    "action" "CopyAction" NOT NULL,
    "position_before" DECIMAL(30,10) NOT NULL,
    "position_after" DECIMAL(30,10) NOT NULL,
    "leader_vwap" DECIMAL(30,10) NOT NULL,
    "leader_time" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL,
    "verdict" "Verdict" NOT NULL,
    "reason" TEXT NOT NULL,
    "trace" JSONB NOT NULL,
    "target_size" DECIMAL(30,10),
    "order_size" DECIMAL(30,10),

    CONSTRAINT "CopyDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" BIGSERIAL NOT NULL,
    "decision_id" BIGINT,
    "position_id" BIGINT,
    "book" "Book" NOT NULL,
    "cloid" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "is_buy" BOOLEAN NOT NULL,
    "size" DECIMAL(30,10) NOT NULL,
    "limit_px" DECIMAL(30,10) NOT NULL,
    "reduce_only" BOOLEAN NOT NULL,
    "purpose" "OrderPurpose" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "OrderStatus" NOT NULL,
    "filled_size" DECIMAL(30,10) NOT NULL DEFAULT 0,
    "avg_px" DECIMAL(30,10),
    "fee_usd" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "slippage_bps" DOUBLE PRECISION,
    "exchange_oid" BIGINT,
    "error" TEXT,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaderFill_wallet_address_time_idx" ON "LeaderFill"("wallet_address", "time");

-- CreateIndex
CREATE INDEX "LeaderFill_wallet_address_signalled_at_idx" ON "LeaderFill"("wallet_address", "signalled_at");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderFill_wallet_address_coin_tid_key" ON "LeaderFill"("wallet_address", "coin", "tid");

-- CreateIndex
CREATE INDEX "CopyDecision_decided_at_idx" ON "CopyDecision"("decided_at");

-- CreateIndex
CREATE INDEX "CopyDecision_wallet_address_decided_at_idx" ON "CopyDecision"("wallet_address", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "CopyDecision_book_signal_key_key" ON "CopyDecision"("book", "signal_key");

-- CreateIndex
CREATE UNIQUE INDEX "Order_cloid_key" ON "Order"("cloid");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- AddForeignKey
ALTER TABLE "LeaderFill" ADD CONSTRAINT "LeaderFill_wallet_address_fkey" FOREIGN KEY ("wallet_address") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyDecision" ADD CONSTRAINT "CopyDecision_wallet_address_fkey" FOREIGN KEY ("wallet_address") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "CopyDecision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "CopyPosition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
