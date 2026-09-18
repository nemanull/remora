const EULER_MASCHERONI = 0.5772156649015329;

export type ReturnMoments = {
  periods: number;
  mean: number;
  sharpe: number;
  skewness: number;
  kurtosis: number;
};

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: number[]): number {
  const mean = average(values);
  return (
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1)
  );
}

export function describeReturns(returns: number[]): ReturnMoments | null {
  if (returns.length < 2) {
    return null;
  }
  const mean = average(returns);
  const deviations = returns.map((value) => value - mean);
  const secondMoment = average(deviations.map((value) => value ** 2));
  if (secondMoment === 0) {
    return null;
  }
  const thirdMoment = average(deviations.map((value) => value ** 3));
  const fourthMoment = average(deviations.map((value) => value ** 4));
  return {
    periods: returns.length,
    mean,
    sharpe: mean / Math.sqrt(sampleVariance(returns)),
    skewness: thirdMoment / secondMoment ** 1.5,
    kurtosis: fourthMoment / secondMoment ** 2,
  };
}

export function computeSortino(returns: number[]): number | null {
  if (returns.length < 2) {
    return null;
  }
  const downsideDeviation = Math.sqrt(
    average(returns.map((value) => Math.min(value, 0) ** 2)),
  );
  if (downsideDeviation === 0) {
    return null;
  }
  return average(returns) / downsideDeviation;
}

export function computePositiveShare(returns: number[]): number | null {
  if (returns.length === 0) {
    return null;
  }
  return returns.filter((value) => value > 0).length / returns.length;
}

export function computeProbabilisticSharpe(
  moments: ReturnMoments,
  benchmarkSharpe = 0,
): number | null {
  const { sharpe, skewness, kurtosis, periods } = moments;
  const variance = 1 - skewness * sharpe + ((kurtosis - 1) / 4) * sharpe ** 2;
  if (variance <= 0) {
    return null;
  }
  return normalCdf(
    ((sharpe - benchmarkSharpe) * Math.sqrt(periods - 1)) / Math.sqrt(variance),
  );
}

export function computeExpectedMaximumSharpe(
  sharpeVariance: number,
  trials: number,
): number {
  return (
    Math.sqrt(sharpeVariance) *
    ((1 - EULER_MASCHERONI) * normalQuantile(1 - 1 / trials) +
      EULER_MASCHERONI * normalQuantile(1 - 1 / (trials * Math.E)))
  );
}

export function computeDeflatedBenchmark(sharpes: number[]): number | null {
  if (sharpes.length < 2) {
    return null;
  }
  return computeExpectedMaximumSharpe(sampleVariance(sharpes), sharpes.length);
}

const ERROR_FUNCTION_COEFFICIENTS = [
  0.17087277, -0.82215223, 1.48851587, -1.13520398, 0.27886807, -0.18628806,
  0.09678418, 0.37409196, 1.00002368, -1.26551223,
];
const CENTRAL_NUMERATOR = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const CENTRAL_DENOMINATOR = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
];
const TAIL_NUMERATOR = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const TAIL_DENOMINATOR = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
];
const LOWER_TAIL = 0.02425;

function evaluatePolynomial(coefficients: number[], x: number): number {
  return coefficients.reduce((sum, coefficient) => sum * x + coefficient, 0);
}

function complementaryErrorFunction(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const value =
    t * Math.exp(-z * z + evaluatePolynomial(ERROR_FUNCTION_COEFFICIENTS, t));
  return x >= 0 ? value : 2 - value;
}

export function normalCdf(x: number): number {
  return 0.5 * complementaryErrorFunction(-x / Math.SQRT2);
}

function computeTailQuantile(probability: number): number {
  const q = Math.sqrt(-2 * Math.log(probability));
  return (
    evaluatePolynomial(TAIL_NUMERATOR, q) /
    (evaluatePolynomial(TAIL_DENOMINATOR, q) * q + 1)
  );
}

export function normalQuantile(probability: number): number {
  if (probability <= 0) {
    return -Infinity;
  }
  if (probability >= 1) {
    return Infinity;
  }
  if (probability < LOWER_TAIL) {
    return computeTailQuantile(probability);
  }
  if (probability > 1 - LOWER_TAIL) {
    return -computeTailQuantile(1 - probability);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    (evaluatePolynomial(CENTRAL_NUMERATOR, r) * q) /
    (evaluatePolynomial(CENTRAL_DENOMINATOR, r) * r + 1)
  );
}
