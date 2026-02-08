/*
  Warnings:

  - Added the required column `fee_token` to the `WalletPosition` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "WalletPosition" ADD COLUMN     "fee_token" TEXT NOT NULL;
