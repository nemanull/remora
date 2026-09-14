import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cloidForOrder } from './cloid';

describe('cloidForOrder', () => {
  it('takes the first 32 hex characters of the SHA-256 of the order origin', () => {
    const digest = createHash('sha256')
      .update('remora-decision-42-ENTRY-1')
      .digest('hex');

    expect(
      cloidForOrder({
        decisionId: 42n,
        positionId: null,
        purpose: 'ENTRY',
        attempt: 1,
      }),
    ).toBe(`0x${digest.slice(0, 32)}`);
  });

  it('is a 128 bit hex string', () => {
    const cloid = cloidForOrder({
      decisionId: 1n,
      positionId: null,
      purpose: 'EXIT',
      attempt: 3,
    });

    expect(cloid).toMatch(/^0x[0-9a-f]{32}$/);
  });

  it('is the same for the same order', () => {
    const order = {
      decisionId: 9n,
      positionId: 3n,
      purpose: 'EXIT' as const,
      attempt: 2,
    };

    expect(cloidForOrder(order)).toBe(cloidForOrder({ ...order }));
  });

  it('differs for every purpose and attempt of one decision', () => {
    const cloids = new Set(
      (['ENTRY', 'EXIT'] as const).flatMap((purpose) =>
        [1, 2, 3].map((attempt) =>
          cloidForOrder({ decisionId: 5n, positionId: null, purpose, attempt }),
        ),
      ),
    );

    expect(cloids.size).toBe(6);
  });

  it('uses the decision when both ids are known', () => {
    expect(
      cloidForOrder({
        decisionId: 5n,
        positionId: 8n,
        purpose: 'EXIT',
        attempt: 1,
      }),
    ).toBe(
      cloidForOrder({
        decisionId: 5n,
        positionId: null,
        purpose: 'EXIT',
        attempt: 1,
      }),
    );
  });

  it('keeps a decision and a position with the same id apart', () => {
    const fromDecision = cloidForOrder({
      decisionId: 5n,
      positionId: null,
      purpose: 'EXIT',
      attempt: 1,
    });
    const fromPosition = cloidForOrder({
      decisionId: null,
      positionId: 5n,
      purpose: 'EXIT',
      attempt: 1,
    });

    expect(fromDecision).not.toBe(fromPosition);
  });

  it('refuses an order without a decision or a position', () => {
    expect(() =>
      cloidForOrder({
        decisionId: null,
        positionId: null,
        purpose: 'STOP',
        attempt: 1,
      }),
    ).toThrow('An order needs a decision or a position for its cloid');
  });
});
