const BASE_DELAY_MS = 4_000;
const MAX_DELAY_MS = 30_000;

export function reconnectDelayMs(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}
