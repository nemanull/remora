export function computeMaxDrawdown(returns: number[]): number | null {
  if (returns.length === 0) {
    return null;
  }
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return maxDrawdown;
}
