import type { Triangular } from './types.ts';

/**
 * Seeded PRNG (mulberry32). Every stochastic draw in the engine goes through
 * one of these so that any run — animated or headless — is reproducible from
 * its seed alone.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  bool(probability: number): boolean {
    return this.next() < probability;
  }

  /**
   * Triangular draw via inverse transform. Used for stow and shuffle times,
   * following Schultz (2018), who models hand-luggage stowage this way.
   */
  triangular(t: Triangular): number {
    const { min, mode, max } = t;
    if (max <= min) return min;
    const u = this.next();
    const split = (mode - min) / (max - min);
    if (u < split) return min + Math.sqrt(u * (max - min) * (mode - min));
    return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
  }

  /**
   * Binomial draw, used for carry-on counts.
   *
   * Preferred over Poisson here because Poisson puts far too much mass on zero:
   * Steffen & Hotchkiss note their passengers "generally had a bag, roll-aboard,
   * or both", with only a small number carrying nothing. Binomial(3, mean/3)
   * hits the same mean with a realistic shape and a natural cap of three items.
   */
  binomial(trials: number, p: number): number {
    let k = 0;
    for (let i = 0; i < trials; i++) if (this.next() < p) k++;
    return k;
  }

  /** Standard normal draw, via Box-Muller. */
  gaussian(): number {
    const u = Math.max(this.next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  /**
   * Log-normal draw with a mean of exactly 1.
   *
   * Used for individual pace. The −σ²/2 term cancels the upward bias of
   * exponentiating a normal, so widening the spread changes who is fast and who
   * is slow without making the population as a whole slower — which would
   * quietly move every calibrated result.
   */
  logNormalUnitMean(sigma: number): number {
    if (sigma <= 0) return 1;
    return Math.exp(this.gaussian() * sigma - (sigma * sigma) / 2);
  }

  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const a = items[i] as T;
      const b = items[j] as T;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }
}
