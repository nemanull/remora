-- CreateEnum
CREATE TYPE "Book" AS ENUM ('MAIN', 'SHADOW');

-- CreateTable
CREATE TABLE "CopyPosition" (
    "id" BIGSERIAL NOT NULL,
    "book" "Book" NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "coin" TEXT NOT NULL,
    "size" DECIMAL(30,10) NOT NULL,
    "entry_px" DECIMAL(30,10),
    "ratio" DECIMAL(30,18) NOT NULL,
    "leader_size_at_sync" DECIMAL(30,10) NOT NULL,
    "allocation_usd" DECIMAL(20,2) NOT NULL,
    "stop_px" DECIMAL(30,10),
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "last_order_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "realized_pnl" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "fees_usd" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "funding_usd" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "leader_open_tid" BIGINT NOT NULL,

    CONSTRAINT "CopyPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookState" (
    "book" "Book" NOT NULL,
    "day_started_at" TIMESTAMPTZ(3) NOT NULL,
    "day_start_equity" DECIMAL(20,2) NOT NULL,
    "kill_switch_active" BOOLEAN NOT NULL DEFAULT false,
    "kill_switch_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BookState_pkey" PRIMARY KEY ("book")
);

-- CreateIndex
CREATE INDEX "CopyPosition_book_is_open_idx" ON "CopyPosition"("book", "is_open");

-- CreateIndex
CREATE INDEX "CopyPosition_wallet_address_is_open_idx" ON "CopyPosition"("wallet_address", "is_open");

-- AddForeignKey
ALTER TABLE "CopyPosition" ADD CONSTRAINT "CopyPosition_wallet_address_fkey" FOREIGN KEY ("wallet_address") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
