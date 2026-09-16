-- CreateTable
CREATE TABLE "Cluster" (
    "id" INTEGER NOT NULL,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "session_id" TEXT,
    "version" TEXT,
    "max_wallets" INTEGER,
    "assign_version" INTEGER NOT NULL DEFAULT 0,
    "connected_at" TIMESTAMPTZ(3),
    "last_heartbeat_at" TIMESTAMPTZ(3),
    "last_stats" JSONB,

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderState" (
    "wallet_address" TEXT NOT NULL,
    "equity_usd" DECIMAL(20,2),
    "equity_at" TIMESTAMPTZ(3),
    "positions" JSONB,
    "positions_at" TIMESTAMPTZ(3),

    CONSTRAINT "LeaderState_pkey" PRIMARY KEY ("wallet_address")
);

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_cluster_id_fkey" FOREIGN KEY ("cluster_id") REFERENCES "Cluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderState" ADD CONSTRAINT "LeaderState_wallet_address_fkey" FOREIGN KEY ("wallet_address") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
