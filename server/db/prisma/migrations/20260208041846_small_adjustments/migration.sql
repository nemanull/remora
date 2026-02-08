/*
  Warnings:

  - You are about to drop the column `first_wallet_snapshot` on the `Wallet` table. All the data in the column will be lost.
  - You are about to drop the column `last_wallet_snapshot` on the `Wallet` table. All the data in the column will be lost.
  - Added the required column `first_timestamp` to the `Wallet` table without a default value. This is not possible if the table is not empty.
  - Added the required column `last_timestamp` to the `Wallet` table without a default value. This is not possible if the table is not empty.
  - Added the required column `profitability_score` to the `Wallet` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Wallet" DROP COLUMN "first_wallet_snapshot",
DROP COLUMN "last_wallet_snapshot",
ADD COLUMN     "first_timestamp" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "last_timestamp" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "profitability_score" DECIMAL(65,30) NOT NULL;
