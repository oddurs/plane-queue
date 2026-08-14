import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  isImprovement,
  measure,
  noiseBand,
  stdErrorOfDifference,
} from '../src/engine/stats.ts';

describe('measure', () => {
  it('runs over a contiguous block of seeds starting at the base', () => {
    const seen: number[] = [];
    measure((seed) => {
      seen.push(seed);
      return seed;
    }, 4, 100);
    expect(seen).toEqual([100, 101, 102, 103]);
  });

  it('reports mean, sample standard deviation and count', () => {
    const values = [10, 12, 14, 16];
    const m = measure((seed) => values[seed] as number, 4, 0);
    expect(m.n).toBe(4);
    expect(m.mean).toBe(13);
    // Sample sd (n-1 denominator) of 10,12,14,16 is √(20/3).
    expect(m.sd).toBeCloseTo(Math.sqrt(20 / 3), 10);
  });

  it('reports zero spread for a single trial rather than dividing by zero', () => {
    const m = measure(() => 42, 1, 0);
    expect(m.mean).toBe(42);
    expect(m.sd).toBe(0);
    expect(Number.isFinite(m.sd)).toBe(true);
  });
});

describe('significance', () => {
  const noisy = { mean: 100, sd: 20, n: 10 };
  const alsoNoisy = { mean: 94, sd: 20, n: 10 };
  const tight = { mean: 100, sd: 1, n: 10 };
  const tighterAndFaster = { mean: 94, sd: 1, n: 10 };

  it('scales the error band with spread and shrinks it with trials', () => {
    expect(stdErrorOfDifference(noisy, alsoNoisy)).toBeGreaterThan(
      stdErrorOfDifference(tight, tighterAndFaster),
    );
    const few = stdErrorOfDifference({ ...noisy, n: 4 }, { ...alsoNoisy, n: 4 });
    const many = stdErrorOfDifference({ ...noisy, n: 100 }, { ...alsoNoisy, n: 100 });
    expect(many).toBeLessThan(few);
  });

  it('uses the smaller sample when the two differ', () => {
    const uneven = stdErrorOfDifference({ ...noisy, n: 4 }, { ...alsoNoisy, n: 100 });
    const both = stdErrorOfDifference({ ...noisy, n: 4 }, { ...alsoNoisy, n: 4 });
    expect(uneven).toBeCloseTo(both, 10);
  });

  it('reports the band as two standard errors', () => {
    expect(noiseBand(noisy, alsoNoisy)).toBeCloseTo(
      2 * stdErrorOfDifference(noisy, alsoNoisy),
      10,
    );
  });

  it('calls a gap an improvement only when it clears the band', () => {
    // Same 6s gap: real against a tight spread, noise against a wide one.
    expect(isImprovement(tight, tighterAndFaster)).toBe(true);
    expect(isImprovement(noisy, alsoNoisy)).toBe(false);
  });

  it('never calls a slower option an improvement', () => {
    expect(isImprovement(tighterAndFaster, tight)).toBe(false);
  });
});

describe('formatDuration', () => {
  it('formats as m:ss with a padded seconds field', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(600)).toBe('10:00');
  });

  it('rounds to the nearest second and carries into minutes', () => {
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(119.5)).toBe('2:00');
  });

  it('treats negatives as magnitudes, since callers format gaps', () => {
    expect(formatDuration(-75)).toBe('1:15');
  });
});
