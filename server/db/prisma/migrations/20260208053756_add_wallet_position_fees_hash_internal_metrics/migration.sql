/*
  Warnings:

  - Added the required column `hash` to the `WalletPosition` table without a default value. This is not possible if the table is not empty.
  - Added the required column `open_fees_usd` to the `WalletPosition` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WalletPosition" ADD COLUMN     "close_fees_usd" DECIMAL(65,30),
ADD COLUMN     "hash" TEXT NOT NULL,
ADD COLUMN     "open_fees_usd" DECIMAL(65,30) NOT NULL;

-- CreateTable
CREATE TABLE "PositionInternalMetrics" (
    "position_id" TEXT NOT NULL,
    "position_copied" TEXT,
    "position_reasonability_score" DECIMAL(65,30),
    "description" TEXT,

    CONSTRAINT "PositionInternalMetrics_pkey" PRIMARY KEY ("position_id")
);

-- CreateIndex
CREATE INDEX "WalletPosition_hash_idx" ON "WalletPosition"("hash");

-- AddForeignKey
ALTER TABLE "PositionInternalMetrics" ADD CONSTRAINT "PositionInternalMetrics_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "WalletPosition"("position_id") ON DELETE CASCADE ON UPDATE CASCADE;
