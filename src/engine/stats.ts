/**
 * The one place a claim gets tested.
 *
 * Boarding is noisy. The findings panel and the policy optimizer both compare a
 * changed scenario against a baseline and both must decide whether a difference
 * is real — and they previously did it with two separate copies of the same
 * arithmetic, which is exactly how two surfaces of one app end up disagreeing
 * about what counts as evidence. There is now a single implementation.
 */

export interface Measurement {
  mean: number;
  /** Sample standard deviation across trials. */
  sd: number;
  n: number;
}

/**
 * Runs `trial` over a fixed, contiguous block of seeds.
 *
 * Callers share the same base seed so competing options face identical
 * passengers — the common-random-numbers trick, which removes most of the
 * variance from the *comparison* even though each individual estimate is noisy.
 */
export function measure(
  trial: (seed: number) => number,
  trials: number,
  baseSeed: number,
): Measurement {
  const values: number[] = [];
  for (let t = 0; t < trials; t++) values.push(trial(baseSeed + t));

  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / (n || 1);
  const variance =
    n < 2 ? 0 : values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  return { mean, sd: Math.sqrt(variance), n };
}

/**
 * Standard error of the difference between two measurements.
 *
 * Sharing seeds makes the two estimates positively correlated, so treating them
 * as independent overstates the error. That is the safe direction: it errs
 * toward calling a difference unproven.
 */
export function stdErrorOfDifference(a: Measurement, b: Measurement): number {
  const n = Math.min(a.n, b.n) || 1;
  return Math.sqrt((a.sd ** 2 + b.sd ** 2) / n);
}

/** Half-width of the reported noise band: two standard errors. */
export function noiseBand(a: Measurement, b: Measurement): number {
  return 2 * stdErrorOfDifference(a, b);
}

/**
 * Whether `b` is meaningfully faster than `a`. A gap smaller than the noise
 * band is reported as no result rather than dressed up as a win.
 */
export function isImprovement(a: Measurement, b: Measurement): boolean {
  return a.mean - b.mean > noiseBand(a, b);
}

/** m:ss. The single duration formatter for the whole app. */
export function formatDuration(seconds: number): string {
  const total = Math.abs(Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
