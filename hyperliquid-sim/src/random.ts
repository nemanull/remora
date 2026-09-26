export type Random = () => number;

type SeedPart = string | number;

function hashParts(parts: SeedPart[]): [number, number, number, number] {
  const text = parts.join(':');
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function createRandom(...parts: SeedPart[]): Random {
  let [a, b, c, d] = hashParts(parts);
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const sum = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const result = (sum + d) | 0;
    c = (c + result) | 0;
    return (result >>> 0) / 4294967296;
  };
}

export function hashUnit(...parts: SeedPart[]): number {
  return hashParts(parts)[0] / 4294967296;
}

export function randomBetween(
  random: Random,
  min: number,
  max: number,
): number {
  return min + random() * (max - min);
}

export function randomInteger(
  random: Random,
  min: number,
  max: number,
): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function randomLogBetween(
  random: Random,
  min: number,
  max: number,
): number {
  return Math.exp(randomBetween(random, Math.log(min), Math.log(max)));
}

export function randomNormal(random: Random): number {
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pickWeighted<T>(
  random: Random,
  items: readonly T[],
  weightOf: (item: T) => number,
): T {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let threshold = random() * total;
  for (const item of items) {
    threshold -= weightOf(item);
    if (threshold < 0) {
      return item;
    }
  }
  return items[items.length - 1];
}

export function shuffle<T>(random: Random, items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function mixRound(value: number, key: number, round: number): number {
  let hash =
    Math.imul(value ^ key, 0x9e3779b1) ^ Math.imul(round + 1, 0x85ebca6b);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 13;
  return hash >>> 0;
}

export function permuteInteger(
  value: number,
  halfBits: number,
  key: number,
): number {
  const half = 2 ** halfBits;
  const mask = half - 1;
  let left = Math.floor(value / half) & mask;
  let right = value % half;
  for (let round = 0; round < 4; round += 1) {
    const next = (left ^ (mixRound(right, key, round) & mask)) >>> 0;
    left = right;
    right = next;
  }
  return left * half + right;
}
