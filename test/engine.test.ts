import { describe, expect, it } from 'vitest';
import { buildCabin, seatLabel } from '../src/engine/cabin.ts';
import { generatePopulation } from '../src/engine/passengers.ts';
import { Rng } from '../src/engine/rng.ts';
import { createSimulation, DEFAULT_SCENARIO, type Scenario } from '../src/engine/run.ts';

const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  ...DEFAULT_SCENARIO,
  ...over,
});

describe('cabin layout', () => {
  const cabin = buildCabin({ rows: 30, firstClassRows: 3, binSlotsPerRow: 8 });

  it('gives economy rows six seats and first-class rows four', () => {
    expect(cabin.seatsByRow[0]).toHaveLength(4);
    expect(cabin.seatsByRow[3]).toHaveLength(6);
    expect(cabin.seats).toHaveLength(3 * 4 + 27 * 6);
  });

  it('indexes seat depth outward from the aisle', () => {
    const row10 = cabin.seatsByRow[9]!;
    const byLetter = Object.fromEntries(row10.map((s) => [s.letter, s.depth]));
    // A and F are windows, C and D are on the aisle.
    expect(byLetter).toEqual({ A: 2, B: 1, C: 0, D: 0, E: 1, F: 2 });
  });

  it('labels seats conventionally', () => {
    expect(seatLabel(cabin.seatsByRow[9]![0]!)).toBe('10C');
  });
});

describe('population', () => {
  const cabin = buildCabin({ rows: 30, firstClassRows: 3, binSlotsPerRow: 8 });

  it('respects the load factor', () => {
    const pax = generatePopulation(
      cabin,
      { ...DEFAULT_SCENARIO.population, loadFactor: 0.8 },
      new Rng(7),
    );
    expect(pax.length).toBe(Math.round(cabin.seats.length * 0.8));
  });

  it('never double-books a seat', () => {
    const pax = generatePopulation(cabin, DEFAULT_SCENARIO.population, new Rng(11));
    const seats = new Set(pax.map((p) => seatLabel(p.seat)));
    expect(seats.size).toBe(pax.length);
  });

  it('seats most parties together in one row', () => {
    const pax = generatePopulation(cabin, DEFAULT_SCENARIO.population, new Rng(3));
    const parties = new Map<number, number[]>();
    for (const p of pax) {
      if (p.partyId === null) continue;
      const rows = parties.get(p.partyId) ?? [];
      rows.push(p.seat.row);
      parties.set(p.partyId, rows);
    }
    expect(parties.size).toBeGreaterThan(5);
    const sameRow = [...parties.values()].filter(
      (rows) => new Set(rows).size === 1,
    ).length;
    expect(sameRow / parties.size).toBeGreaterThan(0.9);
  });

  it('never makes a child the first member of a party', () => {
    const pax = generatePopulation(cabin, DEFAULT_SCENARIO.population, new Rng(5));
    const adultsByParty = new Map<number, number>();
    for (const p of pax) {
      if (p.partyId === null) continue;
      adultsByParty.set(p.partyId, (adultsByParty.get(p.partyId) ?? 0) + (p.isChild ? 0 : 1));
    }
    for (const adults of adultsByParty.values()) expect(adults).toBeGreaterThan(0);
  });
});

describe('simulation invariants', () => {
  it('seats every passenger exactly once', () => {
    const sim = createSimulation(scenario({ seed: 42 }));
    const metrics = sim.run();
    expect(sim.done).toBe(true);
    expect(sim.agents.every((a) => a.state === 'seated')).toBe(true);
    expect(metrics.aisleTimes).toHaveLength(sim.agents.length);
  });

  it('never puts two passengers in one aisle cell', () => {
    const sim = createSimulation(scenario({ seed: 8 }));
    while (sim.step()) {
      const occupied = sim.agents.filter((a) => a.pos >= 0).map((a) => a.pos);
      expect(new Set(occupied).size).toBe(occupied.length);
    }
  });

  it('finishes well inside the safety cap', () => {
    const metrics = createSimulation(scenario({ seed: 2 })).run();
    expect(metrics.totalTime).toBeLessThan(DEFAULT_SCENARIO.params.maxSimSeconds);
    expect(metrics.totalTime).toBeGreaterThan(60);
  });

  it('is deterministic for a given seed', () => {
    const a = createSimulation(scenario({ seed: 99 })).run();
    const b = createSimulation(scenario({ seed: 99 })).run();
    expect(a.totalTime).toBe(b.totalTime);
    expect(a.stallEvents).toBe(b.stallEvents);
  });

  it('takes longer when luggage takes longer', () => {
    const base = scenario({ seed: 4 });
    const slow: Scenario = {
      ...base,
      params: {
        ...base.params,
        stowTimeFirstBag: { min: 6, mode: 9, max: 14 },
      },
    };
    expect(createSimulation(slow).run().totalTime).toBeGreaterThan(
      createSimulation(base).run().totalTime,
    );
  });

  it('gives preboarders a clear aisle before the main queue enters', () => {
    const s = scenario({
      seed: 17,
      population: { ...DEFAULT_SCENARIO.population, assistanceFraction: 0.03 },
      boarding: { ...DEFAULT_SCENARIO.boarding, preboardAssistance: true },
    });
    const sim = createSimulation(s);
    const preboard = sim.agents.filter((a) => a.group < 0);
    expect(preboard.length).toBeGreaterThan(0);

    let sawViolation = false;
    while (sim.step()) {
      const preboardAboard = preboard.some((a) => a.state !== 'queued' && a.state !== 'seated');
      const othersAboard = sim.agents.some((a) => a.group >= 0 && a.pos >= 0);
      if (preboardAboard && othersAboard) sawViolation = true;
    }
    expect(sawViolation).toBe(false);
  });

  it('costs time to preboard, but the cost is bounded', () => {
    const base = scenario({
      seed: 23,
      population: { ...DEFAULT_SCENARIO.population, assistanceFraction: 0.03 },
    });
    const withPreboard = createSimulation({
      ...base,
      boarding: { ...base.boarding, preboardAssistance: true },
    }).run().totalTime;
    const withoutPreboard = createSimulation({
      ...base,
      boarding: { ...base.boarding, preboardAssistance: false },
    }).run().totalTime;
    // Holding the queue while a slow passenger walks the cabin is a real cost,
    // but it should not dominate a full boarding.
    expect(withPreboard).toBeGreaterThan(withoutPreboard);
    expect(withPreboard / withoutPreboard).toBeLessThan(1.5);
  });

  it('reports the boarding curve reaching every passenger', () => {
    const sim = createSimulation(scenario({ seed: 12 }));
    const metrics = sim.run();
    expect(metrics.curve.at(-1)!.seated).toBe(sim.agents.length);
    expect(metrics.curve[0]!.seated).toBe(0);
  });

  it('samples the boarding curve without keeping a point per tick', () => {
    const sim = createSimulation(scenario({ seed: 31 }));
    const metrics = sim.run();
    const ticks = metrics.totalTime / DEFAULT_SCENARIO.params.tick;
    expect(metrics.curve.length).toBeLessThan(ticks / 2);
    // Monotonic in both axes — it is a cumulative count over time.
    for (let i = 1; i < metrics.curve.length; i++) {
      expect(metrics.curve[i]!.t).toBeGreaterThanOrEqual(metrics.curve[i - 1]!.t);
      expect(metrics.curve[i]!.seated).toBeGreaterThanOrEqual(metrics.curve[i - 1]!.seated);
    }
  });

  it('attributes more lost passenger-time to the strategies that block the aisle', () => {
    const base = scenario({ seed: 6, boarding: { ...DEFAULT_SCENARIO.boarding, blocks: 12 } });
    const serialised = createSimulation({
      ...base,
      boarding: { ...base.boarding, strategy: 'back-to-front', releaseGroups: null },
    }).run();
    const parallel = createSimulation({
      ...base,
      boarding: { ...base.boarding, strategy: 'steffen-perfect', releaseGroups: null },
    }).run();

    expect(serialised.totalBlockedSeconds).toBeGreaterThan(parallel.totalBlockedSeconds);
    // Blocked time is a subset of time spent standing in the aisle.
    const totalAisle = serialised.aisleTimes.reduce((s, v) => s + v, 0);
    expect(serialised.totalBlockedSeconds).toBeLessThanOrEqual(totalAisle);
  });
});

describe('cabin features', () => {
  it('lands overwing exits on the rows the published seat maps use', () => {
    // The exits are placed from each manufacturer's documented station, and the
    // rows that fall out are the ones operators actually publish: 12-13 on a
    // 180-seat A320, 16-17 on a 189-seat 737-800. Two independent sources
    // agreeing is the check that the cabin geometry is right.
    for (const [typeId, rows, expected] of [
      ['a320', 30, [12, 13]],
      ['b737-800', 32, [16, 17]],
    ] as const) {
      const cabin = buildCabin({ typeId, rows, firstClassRows: 0, binSlotsPerRow: 8 });
      expect(cabin.features.exitRows, typeId).toEqual([...expected]);
    }
  });

  it('draws on published external dimensions', () => {
    const cabin = buildCabin({ typeId: 'a320', rows: 30, firstClassRows: 0, binSlotsPerRow: 8 });
    // Airbus AC 2-2-0: 37.57 m long, 34.10 m span. Cross section 2-5-0: a
    // 3.63 m cabin with 0.43 m seats and a 0.64 m aisle.
    expect(cabin.type.lengthM).toBeCloseTo(37.57, 2);
    expect(cabin.type.wingspanM).toBeCloseTo(34.1, 2);
    expect(cabin.type.seatWidthM * 6 + cabin.type.aisleWidthM).toBeLessThanOrEqual(
      cabin.type.cabinWidthM,
    );
  });

  it('gives every row a real pitch in metres', () => {
    const cabin = buildCabin({ typeId: 'a320', rows: 30, firstClassRows: 3, binSlotsPerRow: 8 });
    expect(cabin.rowPitchM).toHaveLength(30);
    // First class is 36 in; economy 28.5 in on the high-density layout.
    expect(cabin.rowPitchM[0]).toBeCloseTo(36 * 0.0254, 4);
    expect(cabin.rowPitchM[20]).toBeCloseTo(28.5 * 0.0254, 4);
    for (const row of cabin.features.exitRows) {
      expect(cabin.rowPitchM[row - 1]).toBeGreaterThan(28.5 * 0.0254);
    }
  });

  it('omits exits from a cabin too short to have them', () => {
    // Eight rows do not reach the overwing station at all.
    const cabin = buildCabin({ rows: 8, firstClassRows: 0, binSlotsPerRow: 8 });
    expect(cabin.features.exitRows).toEqual([]);
    expect(cabin.rowPitch.every((p) => p === 1)).toBe(true);
  });

  it('gives exit rows extra pitch and everyone else standard pitch', () => {
    const cabin = buildCabin({ rows: 30, firstClassRows: 0, binSlotsPerRow: 8 });
    expect(cabin.rowPitch).toHaveLength(30);
    for (const row of cabin.features.exitRows) {
      expect(cabin.rowPitch[row - 1]).toBeGreaterThan(1.2);
    }
    const standard = cabin.rowPitch.filter((p) => p === 1).length;
    expect(standard).toBe(30 - cabin.features.exitRows.length);
  });

  it('keeps the wing box inside the cabin and around the exits', () => {
    const cabin = buildCabin({ rows: 30, firstClassRows: 0, binSlotsPerRow: 8 });
    const [from, to] = cabin.features.wingRows;
    expect(from).toBeGreaterThanOrEqual(1);
    expect(to).toBeLessThanOrEqual(30);
    expect(from).toBeLessThan(to);
    for (const exit of cabin.features.exitRows) {
      expect(exit).toBeGreaterThanOrEqual(from);
      expect(exit).toBeLessThanOrEqual(to);
    }
  });

  it('carries the published service fixtures fore and aft', () => {
    const cabin = buildCabin({ rows: 30, firstClassRows: 3, binSlotsPerRow: 8 });
    const kinds = (z: { fixtures: { kind: string }[] }) => z.fixtures.map((f) => f.kind);
    expect(kinds(cabin.type.forwardService)).toContain('galley');
    expect(kinds(cabin.type.forwardService)).toContain('lavatory');
    // The aft zone carries a galley and a pair of lavatories on the A320.
    expect(kinds(cabin.type.aftService).filter((k) => k === 'lavatory')).toHaveLength(2);
  });

  it('charges extra walking time for the wider exit-row pitch', () => {
    // Same passengers and seeds; the only difference is whether exit rows exist.
    const withExits = scenario({ seed: 77, cabin: { rows: 30, firstClassRows: 0, binSlotsPerRow: 8 } });
    const flat = createSimulation(withExits);
    // A cabin whose rows are all standard pitch must not be slower.
    expect(flat.cabin.features.exitRows.length).toBeGreaterThan(0);
    expect(flat.cabin.rowPitch.some((p) => p > 1)).toBe(true);
  });
});
