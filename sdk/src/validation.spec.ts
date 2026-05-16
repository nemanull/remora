import { describe, expect, it } from 'vitest';
import { validateWallet } from './validation.js';

describe('validateWallet', () => {
  it('returns an address with the 0x prefix and 40 hex characters', () => {
    expect(validateWallet('0xc5fdde670e647823dbf07a09c452fe3f33df8677')).toBe(
      '0xc5fdde670e647823dbf07a09c452fe3f33df8677',
    );
  });

  it('rejects an address that is one character short', () => {
    expect(
      validateWallet('0xc5fdde670e647823dbf07a09c452fe3f33df867'),
    ).toBeNull();
  });

  it('rejects an address without the 0x prefix', () => {
    expect(
      validateWallet('c5fdde670e647823dbf07a09c452fe3f33df867700'),
    ).toBeNull();
  });

  it('rejects the placeholder of the env example', () => {
    expect(validateWallet('0x....')).toBeNull();
  });
});
