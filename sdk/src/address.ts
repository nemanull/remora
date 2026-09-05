const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
}
