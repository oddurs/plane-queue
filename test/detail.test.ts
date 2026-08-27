import { describe, expect, it } from 'vitest';
import { buildCabin } from '../src/engine/cabin.ts';
import { AIRCRAFT_TYPES } from '../src/engine/aircraft.ts';
import { overviewHeight } from '../src/render/cabin-canvas.ts';
import { generatePopulation } from '../src/engine/passengers.ts';
import { Rng } from '../src/engine/rng.ts';
import { createSimulation, runScenario, DEFAULT_SCENARIO, type Scenario } from '../src/engine/run.ts';

const population = (over = {}) => ({ ...DEFAULT_SCENARIO.population, ...over });

describe('individual pace', () => {
  const cabin = buildCabin({ rows: 30, firstClassRows: 0, binSlotsPerRow: 8 });

  it('gives everyone the same pace at zero spread', () => {
    const pax = generatePopulation(cabin, population({ speedSpread: 0, partyFraction: 0, assistanceFraction: 0 }), new Rng(1));
    const factors = new Set(pax.filter((p) => !p.isChild).map((p) => p.slowFactor));
    expect(factors).toEqual(new Set([1]));
  });

  it('spreads pace without moving the average', () => {
    // A wider spread must change who is quick, not make the aircraft slower —
    // otherwise every calibrated result would drift with a cosmetic slider.
    const mean = (spread: number): number => {
      const pax = generatePopulation(
        cabin,
        population({ speedSpread: spread, partyFraction: 0, assistanceFraction: 0, childFraction: 0 }),
        new Rng(9),
      );
      return pax.reduce((s, p) => s + p.slowFactor, 0) / pax.length;
    };
    expect(mean(0)).toBeCloseTo(1, 6);
    expect(mean(0.35)).toBeCloseTo(1, 1);
  });

  it('produces a genuine mix of quick and slow', () => {
    const pax = generatePopulation(cabin, population({ speedSpread: 0.35 }), new Rng(4));
    const factors = pax.map((p) => p.slowFactor);
    expect(Math.min(...factors)).toBeLessThan(0.8);
    expect(Math.max(...factors)).toBeGreaterThan(1.3);
  });

  it('keeps pace inside plausible human bounds', () => {
    const pax = generatePopulation(cabin, population({ speedSpread: 0.5 }), new Rng(6));
    for (const p of pax) {
      expect(p.slowFactor).toBeGreaterThanOrEqual(0.65);
      expect(p.slowFactor).toBeLessThanOrEqual(2.2);
    }
  });
});

describe('gate-checking when the cabin fills', () => {
  const capacity = DEFAULT_SCENARIO.cabin.rows * DEFAULT_SCENARIO.cabin.binSlotsPerRow;

  it('takes nothing while the bins can hold everything', () => {
    const light: Scenario = { ...DEFAULT_SCENARIO, population: population({ meanBags: 0.5 }), seed: 5 };
    expect(runScenario(light).gateChecked).toBe(0);
  });

  it('takes only the excess once they cannot', () => {
    const heavy: Scenario = { ...DEFAULT_SCENARIO, population: population({ meanBags: 2.5 }), seed: 5 };
    const sim = createSimulation(heavy);
    const carried = sim.agents.reduce((s, a) => s + a.passenger.bags, 0);
    const metrics = sim.run();

    expect(metrics.gateChecked).toBeGreaterThan(0);
    // What is left in the cabin should come out at or just under capacity.
    expect(carried - metrics.gateChecked).toBeLessThanOrEqual(capacity);
    expect(carried - metrics.gateChecked).toBeGreaterThan(capacity * 0.9);
  });

  it('takes bags from the back of the queue, never from preboarders', () => {
    const heavy: Scenario = {
      ...DEFAULT_SCENARIO,
      population: population({ meanBags: 2.5, assistanceFraction: 0.05 }),
      boarding: { ...DEFAULT_SCENARIO.boarding, preboardAssistance: true },
      seed: 7,
    };
    const sim = createSimulation(heavy);
    const checked = sim.agents.filter((a) => a.gateCheckedBags > 0);
    expect(checked.length).toBeGreaterThan(0);

    // Nobody boarding ahead of the main queue loses a bag.
    expect(checked.every((a) => a.group >= 0)).toBe(true);
    // And those who do are the later part of the queue.
    const earliest = Math.min(...checked.map((a) => a.order));
    expect(earliest).toBeGreaterThan(sim.agents.length / 2);
  });

  it('caps how bad a bag-heavy flight gets', () => {
    // The point of the rule: past the binding constraint the marginal passenger
    // has nothing to stow, so boarding time stops climbing.
    const at = (meanBags: number, gateCheck: boolean): number =>
      runScenario({
        ...DEFAULT_SCENARIO,
        population: population({ meanBags }),
        params: { ...DEFAULT_SCENARIO.params, gateCheckWhenFull: gateCheck },
        seed: 5,
      }).totalTime;

    expect(at(2.5, true)).toBeLessThan(at(2.5, false));
    // Below capacity the rule is inert and both paths agree exactly.
    expect(at(0.5, true)).toBe(at(0.5, false));
  });
});

describe('parties at the row', () => {
  it('lets one companion take the bags rather than each repeating the job', () => {
    const solo = runScenario({
      ...DEFAULT_SCENARIO,
      population: population({ partyFraction: 0 }),
      params: { ...DEFAULT_SCENARIO.params, partyStowShare: 1 },
      seed: 3,
    }).totalTime;

    const grouped = (share: number): number =>
      runScenario({
        ...DEFAULT_SCENARIO,
        population: population({ partyFraction: 0.8 }),
        params: { ...DEFAULT_SCENARIO.params, partyStowShare: share },
        seed: 3,
      }).totalTime;

    // Sharing the work at the bin must not cost more than doing it separately.
    expect(grouped(0.45)).toBeLessThanOrEqual(grouped(1));
    expect(solo).toBeGreaterThan(0);
  });

  it('stays deterministic with all the new detail switched on', () => {
    const rich: Scenario = {
      ...DEFAULT_SCENARIO,
      population: population({ meanBags: 2.2, partyFraction: 0.7, childFraction: 0.5, speedSpread: 0.4 }),
      seed: 12,
    };
    const a = runScenario(rich);
    const b = runScenario(rich);
    expect(a.totalTime).toBe(b.totalTime);
    expect(a.gateChecked).toBe(b.gateChecked);
    expect(a.stallEvents).toBe(b.stallEvents);
  });
});

describe('the gate drawing', () => {
  it('has a door to draw the airbridge onto, whatever the aircraft', () => {
    // The bridge anchors on door 1L. Without one it would meet the nose.
    for (const type of AIRCRAFT_TYPES) {
      expect(type.doors.some((d) => d.id === '1L' && d.type === 'passenger'), type.id).toBe(
        true,
      );
    }
  });

});

describe('the two panes', () => {
  it('splits the canvas so a click can be attributed to one of them', () => {
    // The pane boundary is the only thing outside the renderer has to know: a
    // point is on the map, which steers, or on the cutaway, which does not.
    expect(overviewHeight(1000)).toBeLessThan(1000 / 2);
    expect(overviewHeight(200)).toBe(Math.round(200 * 0.42));
    // The strip never grows past its own ceiling, however tall the frame.
    expect(overviewHeight(4000)).toBe(overviewHeight(2000));
    // ...and never takes more than its share of a short one.
    for (const h of [180, 300, 420, 900]) {
      expect(overviewHeight(h), `h=${h}`).toBeLessThanOrEqual(Math.round(h * 0.42));
      expect(overviewHeight(h), `h=${h}`).toBeGreaterThan(0);
    }
  });
});
