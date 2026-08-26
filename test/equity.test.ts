import { describe, expect, it } from 'vitest';
import { computeEquity, describeEquity, gini } from '../src/engine/equity.ts';
import { runScenario, DEFAULT_SCENARIO } from '../src/engine/run.ts';
import type { PassengerWait } from '../src/engine/types.ts';

const wait = (over: Partial<PassengerWait> = {}): PassengerWait => ({
  row: 1,
  depth: 0,
  maxDepth: 2,
  partyId: null,
  needsAssistance: false,
  assistance: 'none',
  seconds: 0,
  blocked: 0,
  ...over,
});

describe('gini', () => {
  it('is zero when everyone bears the same', () => {
    expect(gini([5, 5, 5, 5])).toBeCloseTo(0, 10);
  });

  it('is zero when nobody bears anything', () => {
    expect(gini([0, 0, 0])).toBe(0);
    expect(gini([])).toBe(0);
  });

  it('approaches one as the whole burden falls on a single person', () => {
    const ten = gini([0, 0, 0, 0, 0, 0, 0, 0, 0, 100]);
    const hundred = gini([...Array(99).fill(0), 100]);
    // The maximum for n values is (n-1)/n, so it rises with population.
    expect(ten).toBeCloseTo(0.9, 6);
    expect(hundred).toBeCloseTo(0.99, 6);
    expect(hundred).toBeGreaterThan(ten);
  });

  it('rises as the same total is concentrated further', () => {
    const even = gini([10, 10, 10, 10]);
    const skewed = gini([1, 2, 7, 30]);
    const extreme = gini([0, 0, 0, 40]);
    expect(even).toBeLessThan(skewed);
    expect(skewed).toBeLessThan(extreme);
  });
});

describe('computeEquity', () => {
  it('measures imposed delay, not time aboard', () => {
    // Row 30 is aboard far longer simply because it is further to walk. That is
    // geometry, and must not read as a strategy penalising the rear.
    const waits = [
      wait({ row: 1, seconds: 10, blocked: 40 }),
      wait({ row: 30, seconds: 400, blocked: 0 }),
    ];
    const e = computeEquity(waits, 30);
    expect(e.byRow[0]).toBe(40);
    expect(e.byRow[29]).toBe(0);
  });

  it('splits the cabin into thirds and attributes each passenger once', () => {
    const waits = [
      wait({ row: 2, blocked: 10 }),
      wait({ row: 15, blocked: 20 }),
      wait({ row: 29, blocked: 30 }),
    ];
    const e = computeEquity(waits, 30);
    expect(e.byZone.map((b) => b.count)).toEqual([1, 1, 1]);
    expect(e.byZone.map((b) => Math.round(b.meanWait))).toEqual([10, 20, 30]);
  });

  it('classifies window, middle and aisle by depth relative to the row', () => {
    const waits = [
      wait({ depth: 2, maxDepth: 2, blocked: 30 }),
      wait({ depth: 1, maxDepth: 2, blocked: 20 }),
      wait({ depth: 0, maxDepth: 2, blocked: 10 }),
      // A 2-2 first-class row: depth 1 is the window there, not the middle.
      wait({ depth: 1, maxDepth: 1, blocked: 6 }),
    ];
    const e = computeEquity(waits, 30);
    const byLabel = Object.fromEntries(e.byColumn.map((b) => [b.label, b]));
    expect(byLabel['Window']?.count).toBe(2);
    expect(byLabel['Middle']?.count).toBe(1);
    expect(byLabel['Aisle']?.count).toBe(1);
  });

  it('omits cohorts nobody belongs to', () => {
    const e = computeEquity([wait({ blocked: 5 })], 30);
    expect(e.byCohort.map((b) => b.label)).toEqual(['Alone']);
  });

  it('reports the worst tenth as a bounded share of the total', () => {
    // Ten passengers, one of whom absorbs everything.
    const waits = [...Array(9)].map(() => wait({ blocked: 0 }));
    waits.push(wait({ blocked: 100 }));
    const e = computeEquity(waits, 30);
    expect(e.worstTenthShare).toBeCloseTo(1, 6);

    const even = computeEquity([...Array(10)].map(() => wait({ blocked: 5 })), 30);
    expect(even.worstTenthShare).toBeCloseTo(0.1, 6);
  });

  it('survives a population that never waited at all', () => {
    const e = computeEquity([...Array(5)].map(() => wait({ blocked: 0 })), 30);
    expect(e.gini).toBe(0);
    expect(e.worstTenthShare).toBe(0);
    expect(Number.isFinite(e.median)).toBe(true);
  });

  it('handles an empty run without dividing by zero', () => {
    const e = computeEquity([], 30);
    expect(e.byRow).toEqual([]);
    expect(e.gini).toBe(0);
  });
});

describe('the distribution of a real boarding', () => {
  const equityFor = (strategy: 'back-to-front' | 'steffen-perfect' | 'outside-in') => {
    const m = runScenario({
      ...DEFAULT_SCENARIO,
      boarding: { ...DEFAULT_SCENARIO.boarding, strategy },
      seed: 4,
    });
    return computeEquity(m.waits, DEFAULT_SCENARIO.cabin.rows);
  };

  it('attributes a wait to every passenger who boarded', () => {
    const m = runScenario({ ...DEFAULT_SCENARIO, seed: 4 });
    expect(m.waits).toHaveLength(m.aisleTimes.length);
    for (const w of m.waits) {
      expect(w.blocked).toBeLessThanOrEqual(w.seconds + 1e-9);
      expect(w.row).toBeGreaterThan(0);
    }
  });

  it('leaves the rear of the cabin carrying more delay than the front', () => {
    // Passengers heading aft queue behind everyone stowing ahead of them, under
    // every strategy — the burden follows the walk, not the boarding order.
    const e = equityFor('back-to-front');
    const [forward, , rear] = e.byZone;
    expect(rear!.meanWait).toBeGreaterThan(forward!.meanWait);
  });

  it('shows the faster strategies cutting delay in absolute terms', () => {
    const slow = equityFor('back-to-front');
    const fast = equityFor('steffen-perfect');
    for (let i = 0; i < 3; i++) {
      expect(fast.byZone[i]!.meanWait).toBeLessThan(slow.byZone[i]!.meanWait);
    }
  });

  it('describes the spread without passing judgement on it', () => {
    const text = describeEquity(equityFor('outside-in'));
    expect(text).toMatch(/worst-served tenth/);
    expect(text).toMatch(/Gini/);
    // The app reports who bears what; it does not call an arrangement unfair.
    expect(text.toLowerCase()).not.toMatch(/unfair|unjust|should/);
  });
});
