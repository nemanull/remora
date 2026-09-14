import { createHash } from 'node:crypto';
import type { OrderPurpose } from '../copy/types';

const CLOID_HEX_LENGTH = 32;

export function cloidForOrder(input: {
  decisionId: bigint | null;
  positionId: bigint | null;
  purpose: OrderPurpose;
  attempt: number;
}): string {
  const origin =
    input.decisionId !== null
      ? `decision-${input.decisionId}`
      : input.positionId !== null
        ? `position-${input.positionId}`
        : null;
  if (origin === null) {
    throw new Error('An order needs a decision or a position for its cloid');
  }
  const digest = createHash('sha256')
    .update(`remora-${origin}-${input.purpose}-${input.attempt}`)
    .digest('hex');
  return `0x${digest.slice(0, CLOID_HEX_LENGTH)}`;
}
