/*
  Warnings:

  - The primary key for the `Wallet` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `first_timestamp` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `is_personal` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `last_timestamp` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `profitability_score` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `wallet_id` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the `BalanceSnapshot` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PositionInternalMetrics` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PositionMetrics` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WalletPosition` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `source` to the `Wallet` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `Wallet` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('CANDIDATE', 'SHADOW', 'LIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "WalletSource" AS ENUM ('LEADERBOARD', 'MANUAL');

-- DropForeignKey
ALTER TABLE "BalanceSnapshot" DROP CONSTRAINT "BalanceSnapshot_wallet_id_fkey";

-- DropForeignKey
ALTER TABLE "PositionInternalMetrics" DROP CONSTRAINT "PositionInternalMetrics_position_id_fkey";

-- DropForeignKey
ALTER TABLE "PositionMetrics" DROP CONSTRAINT "PositionMetrics_position_id_fkey";

-- DropForeignKey
ALTER TABLE "WalletPosition" DROP CONSTRAINT "WalletPosition_copied_from_id_fkey";

-- DropForeignKey
ALTER TABLE "WalletPosition" DROP CONSTRAINT "WalletPosition_wallet_id_fkey";

-- DropIndex
DROP INDEX "Wallet_address_idx";

-- AlterTable
ALTER TABLE "Wallet" DROP CONSTRAINT "Wallet_pkey",
DROP COLUMN "first_timestamp",
DROP COLUMN "is_personal",
DROP COLUMN "last_timestamp",
DROP COLUMN "profitability_score",
DROP COLUMN "wallet_id",
ADD COLUMN     "cluster_id" INTEGER,
ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "fills_synced_until" TIMESTAMPTZ(3),
ADD COLUMN     "is_paused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "live_since" TIMESTAMPTZ(3),
ADD COLUMN     "miss_streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retired_at" TIMESTAMPTZ(3),
ADD COLUMN     "score" DOUBLE PRECISION,
ADD COLUMN     "scored_at" TIMESTAMPTZ(3),
ADD COLUMN     "source" "WalletSource" NOT NULL,
ADD COLUMN     "status" "WalletStatus" NOT NULL DEFAULT 'CANDIDATE',
ADD COLUMN     "status_reason" TEXT,
ADD COLUMN     "top_streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tracked_since" TIMESTAMPTZ(3),
ADD COLUMN     "updated_at" TIMESTAMPTZ(3) NOT NULL,
ADD CONSTRAINT "Wallet_pkey" PRIMARY KEY ("address");

-- DropTable
DROP TABLE "BalanceSnapshot";

-- DropTable
DROP TABLE "PositionInternalMetrics";

-- DropTable
DROP TABLE "PositionMetrics";

-- DropTable
DROP TABLE "WalletPosition";

-- DropEnum
DROP TYPE "LeverageMode";

-- DropEnum
DROP TYPE "PositionStatus";

-- DropEnum
DROP TYPE "PositionType";

-- CreateIndex
CREATE INDEX "Wallet_status_idx" ON "Wallet"("status");
