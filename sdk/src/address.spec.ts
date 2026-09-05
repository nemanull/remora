import { describe, expect, it } from 'vitest';
import { normalizeAddress } from './address.js';

describe('normalizeAddress', () => {
  it('lowercases a checksummed address', () => {
    expect(normalizeAddress('0xC5fDDe670E647823dBf07A09c452FE3F33dF8677')).toBe(
      '0xc5fdde670e647823dbf07a09c452fe3f33df8677',
    );
  });

  it('keeps a lowercase address as it is', () => {
    expect(normalizeAddress('0xc5fdde670e647823dbf07a09c452fe3f33df8677')).toBe(
      '0xc5fdde670e647823dbf07a09c452fe3f33df8677',
    );
  });

  it.each([
    [
      '42 characters after the prefix',
      '0xc5fdde670e647823dbf07a09c452fe3f33df867700',
    ],
    [
      '39 characters after the prefix',
      '0xc5fdde670e647823dbf07a09c452fe3f33df867',
    ],
    [
      'a character that is not hex',
      '0xg5fdde670e647823dbf07a09c452fe3f33df8677',
    ],
    ['no prefix', 'c5fdde670e647823dbf07a09c452fe3f33df867700'],
    ['surrounding whitespace', ' 0xc5fdde670e647823dbf07a09c452fe3f33df8677'],
    ['an empty string', ''],
  ])('rejects %s', (_, value) => {
    expect(normalizeAddress(value)).toBeNull();
  });

  it.each([
    null,
    undefined,
    42,
    {},
    ['0xc5fdde670e647823dbf07a09c452fe3f33df8677'],
  ])('rejects the non-string value %j', (value) => {
    expect(normalizeAddress(value)).toBeNull();
  });
});
