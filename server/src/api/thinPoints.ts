export function thinPoints<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) {
    return points;
  }
  const step = Math.ceil(points.length / maxPoints);
  const thinned = points.filter((_, index) => index % step === 0);
  const last = points.at(-1);
  if (last !== undefined && thinned.at(-1) !== last) {
    thinned.push(last);
  }
  return thinned;
}
