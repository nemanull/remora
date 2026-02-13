/*
  Warnings:

  - You are about to drop the column `position_copied` on the `PositionInternalMetrics` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[copied_from_id]` on the table `WalletPosition` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PositionStatus" ADD VALUE 'OPENING';
ALTER TYPE "PositionStatus" ADD VALUE 'CLOSING';
ALTER TYPE "PositionStatus" ADD VALUE 'ERROR';

-- AlterTable
ALTER TABLE "PositionInternalMetrics" DROP COLUMN "position_copied";

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "is_personal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WalletPosition" ADD COLUMN     "copied_from_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WalletPosition_copied_from_id_key" ON "WalletPosition"("copied_from_id");

-- CreateIndex
CREATE INDEX "WalletPosition_copied_from_id_idx" ON "WalletPosition"("copied_from_id");

-- AddForeignKey
ALTER TABLE "WalletPosition" ADD CONSTRAINT "WalletPosition_copied_from_id_fkey" FOREIGN KEY ("copied_from_id") REFERENCES "WalletPosition"("position_id") ON DELETE SET NULL ON UPDATE CASCADE;
