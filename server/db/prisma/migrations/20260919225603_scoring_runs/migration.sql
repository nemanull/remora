-- CreateTable
CREATE TABLE "ScoringRun" (
    "id" TEXT NOT NULL,
    "model_version" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "expected_scores" INTEGER,
    "leaderboard_rows" INTEGER,
    "stage_one_count" INTEGER,
    "stage_two_count" INTEGER,
    "stage_three_count" INTEGER,

    CONSTRAINT "ScoringRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletScore" (
    "id" SERIAL NOT NULL,
    "run_id" TEXT NOT NULL,
    "wallet_address" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "gate_failures" TEXT[],
    "preliminary" DOUBLE PRECISION,
    "composite" DOUBLE PRECISION,
    "account_value_usd" DECIMAL(20,2) NOT NULL,
    "history_days" INTEGER NOT NULL,
    "periods" INTEGER NOT NULL,
    "psr" DOUBLE PRECISION,
    "dsr" DOUBLE PRECISION,
    "max_drawdown" DOUBLE PRECISION,
    "edge_bps" DOUBLE PRECISION,
    "sortino_30d" DOUBLE PRECISION,
    "positive_share" DOUBLE PRECISION,
    "perp_pnl_share" DOUBLE PRECISION,
    "hold_minutes" DOUBLE PRECISION,
    "orders_per_day" DOUBLE PRECISION,
    "maker_share" DOUBLE PRECISION,
    "core_notional_share" DOUBLE PRECISION,
    "fills_window_from" TIMESTAMPTZ(3),
    "components" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookSnapshot" (
    "book" "Book" NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL,
    "equity_usd" DECIMAL(20,2) NOT NULL,
    "unrealized_pnl" DECIMAL(20,2) NOT NULL,
    "realized_pnl_today" DECIMAL(20,2) NOT NULL,
    "gross_exposure_usd" DECIMAL(20,2) NOT NULL,
    "open_positions" INTEGER NOT NULL,

    CONSTRAINT "BookSnapshot_pkey" PRIMARY KEY ("book","taken_at")
);

-- CreateIndex
CREATE INDEX "WalletScore_wallet_address_created_at_idx" ON "WalletScore"("wallet_address", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "WalletScore_run_id_wallet_address_key" ON "WalletScore"("run_id", "wallet_address");

-- AddForeignKey
ALTER TABLE "WalletScore" ADD CONSTRAINT "WalletScore_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ScoringRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletScore" ADD CONSTRAINT "WalletScore_wallet_address_fkey" FOREIGN KEY ("wallet_address") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
