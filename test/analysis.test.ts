import { describe, expect, it } from 'vitest';
import { createSimulation, DEFAULT_SCENARIO, type Scenario } from '../src/engine/run.ts';
import { sweepParameter, SWEEP_AXES, STRICT_ORDER } from '../src/engine/batch.ts';
import { runCalibration } from '../src/engine/calibration.ts';

const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  ...DEFAULT_SCENARIO,
  ...over,
});

describe('congestion heatmap data', () => {
  it('accounts for all blocked time and fits the declared grid', () => {
    const metrics = createSimulation(scenario({ seed: 3 })).run();
    const { congestion } = metrics;

    expect(congestion.rows).toBe(DEFAULT_SCENARIO.cabin.rows);
    expect(congestion.buckets).toBeGreaterThan(0);
    expect(congestion.data).toHaveLength(congestion.buckets * congestion.rows);

    // The grid covers the cabin aisle only; time spent waiting at the doorway
    // is counted as blocked but has no row to attribute it to.
    const summed = congestion.data.reduce((s, v) => s + v, 0);
    expect(summed).toBeGreaterThan(0);
    expect(summed).toBeLessThanOrEqual(metrics.totalBlockedSeconds + 1e-6);
    expect(congestion.peak).toBeGreaterThan(0);
    expect(congestion.peak).toBeLessThanOrEqual(summed);
  });

  const congestionFor = (strategy: 'steffen-perfect' | 'back-to-front', seed: number) =>
    createSimulation(
      scenario({
        seed,
        boarding: {
          ...DEFAULT_SCENARIO.boarding,
          strategy,
          blocks: 12,
          releaseGroups: null,
          preboardAssistance: false,
          familiesBoardTogether: false,
        },
      }),
    ).run().congestion;

  function thirds(c: ReturnType<typeof congestionFor>): { front: number; rear: number } {
    let front = 0;
    let rear = 0;
    for (let b = 0; b < c.buckets; b++) {
      for (let r = 0; r < c.rows; r++) {
        const v = c.data[b * c.rows + r] ?? 0;
        if (r < c.rows / 3) front += v;
        else if (r >= (c.rows * 2) / 3) rear += v;
      }
    }
    return { front, rear };
  }

  it('puts the back-to-front jam in the front of the cabin, not the rear', () => {
    // Counter-intuitive but correct: passengers walking to the rear queue up
    // *behind* whoever is stowing, and that tail stretches forward toward the
    // door. The delay therefore accumulates in the forward rows even though
    // everyone is trying to reach the back.
    const { front, rear } = thirds(congestionFor('back-to-front', 4));
    expect(front).toBeGreaterThan(rear);
  });

  it('produces markedly less total and peak congestion under Steffen', () => {
    const steffen = congestionFor('steffen-perfect', 9);
    const backToFront = congestionFor('back-to-front', 9);
    const total = (c: typeof steffen): number => c.data.reduce((s, v) => s + v, 0);

    expect(total(steffen)).toBeLessThan(total(backToFront));
    expect(steffen.peak).toBeLessThan(backToFront.peak);
  });
});

describe('sensitivity sweep', () => {
  it('returns a median for every strategy at every value', () => {
    const axis = SWEEP_AXES.find((a) => a.param === 'meanBags')!;
    const result = sweepParameter(DEFAULT_SCENARIO, axis, 3);

    expect(result.series).toHaveLength(8);
    for (const s of result.series) {
      expect(s.medians, s.name).toHaveLength(axis.values.length);
      expect(s.medians.every((m) => m > 0), s.name).toBe(true);
    }
  });

  it('shows boarding time rising with carry-on bags for every strategy', () => {
    const axis = SWEEP_AXES.find((a) => a.param === 'meanBags')!;
    const result = sweepParameter(DEFAULT_SCENARIO, axis, 5);
    for (const s of result.series) {
      const first = s.medians[0] as number;
      const last = s.medians.at(-1) as number;
      expect(last, s.name).toBeGreaterThan(first);
    }
  });

  it('collapses the strategies together at a single release group', () => {
    const axis = SWEEP_AXES.find((a) => a.param === 'releaseGroups')!;
    expect(axis.values[0]).toBe(1);
    expect(axis.values.at(-1)).toBe(STRICT_ORDER);

    const result = sweepParameter(DEFAULT_SCENARIO, axis, 8);
    const at = (i: number): number[] => result.series.map((s) => s.medians[i] as number);

    const oneGroup = at(0);
    const strict = at(axis.values.length - 1);
    const range = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);

    // With one group nobody's order is enforced, so every strategy is really
    // random boarding; with strict order the methods separate.
    expect(range(oneGroup)).toBeLessThan(range(strict));
  });
});

describe('in-app calibration', () => {
  const rows = runCalibration(20);

  it('covers all five published methods', () => {
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.measured)).toEqual([216, 253, 284, 371, 414]);
  });

  it('lands within 15% on the three robustly reproduced methods', () => {
    for (const method of ['Outside-in (WilMA)', 'Random', 'Back-to-front (by row)']) {
      const row = rows.find((r) => r.method === method)!;
      expect(Math.abs(row.error), `${method} ${row.simulated.toFixed(0)}s`).toBeLessThan(0.15);
    }
  });

  it('flags the two methods it knowingly deviates on', () => {
    const noted = rows.filter((r) => r.note).map((r) => r.method);
    expect(noted).toEqual(['Steffen (perfect)', 'Blocks (3 × 4 rows)']);
  });
});
