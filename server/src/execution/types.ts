import type { Decimal } from 'decimal.js';

export type OrderRequest = {
  cloid: string;
  coin: string;
  isBuy: boolean;
  size: Decimal;
  limitPx: Decimal;
  reduceOnly: boolean;
  heldSize: Decimal;
};

export type ExecutionStatus =
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'UNFILLED'
  | 'REJECTED'
  | 'UNKNOWN';

export type ExecutionResult = {
  status: ExecutionStatus;
  filledSize: Decimal;
  averagePrice: Decimal | null;
  feeUsd: Decimal;
  exchangeOid: bigint | null;
  error: string | null;
  acknowledgedAt: Date | null;
};

export type Executor = {
  execute(order: OrderRequest): Promise<ExecutionResult>;
};

export const IOC_UNFILLED = 'ioc_unfilled';
