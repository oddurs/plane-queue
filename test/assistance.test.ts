import { describe, expect, it } from 'vitest';
import { buildCabin } from '../src/engine/cabin.ts';
import { generatePopulation, DEFAULT_ASSISTANCE_MIX } from '../src/engine/passengers.ts';
import { createSimulation, DEFAULT_SCENARIO, type Scenario } from '../src/engine/run.ts';
import { Rng } from '../src/engine/rng.ts';
import { ASSISTANCE_KINDS, type AssistanceKind } from '../src/engine/types.ts';

/**
 * Preboarding, modelled as the thing it actually is.
 *
 * It used to be one boolean and a slow-factor: a passenger needing assistance
 * walked at 40% pace and sat down slowly. That misses what preboarding is for.
 * Somebody transferred to an aisle chair is carried aboard by crew who then
 * have to walk back out through everyone still boarding, and the aircraft is
 * not ready until they are off it. None of that is a slower passenger.
 */

/** A scenario with a guaranteed, controllable population of one kind. */
function only(kind: Exclude<AssistanceKind, 'none'>, over: Partial<Scenario> = {}): Scenario {
  const base = structuredClone(DEFAULT_SCENARIO);
  return {
    ...base,
    ...over,
    population: {
      ...base.population,
      assistanceFraction: 0.05,
      assistanceMix: Object.fromEntries(
        ASSISTANCE_KINDS.map((k) => [k, k === kind ? 1 : 0]),
      ) as typeof DEFAULT_ASSISTANCE_MIX,
      ...over.population,
    },
  };
}

describe('the assistance taxonomy', () => {
  it('gives every passenger a kind, and only the assisted a real one', () => {
    const cabin = buildCabin(DEFAULT_SCENARIO.cabin);
    const pax = generatePopulation(
      cabin,
      { ...DEFAULT_SCENARIO.population, assistanceFraction: 0.4 },
      new Rng(3),
    );
    for (const p of pax) {
      expect(p.needsAssistance).toBe(p.assistance !== 'none');
      expect(['none', ...ASSISTANCE_KINDS]).toContain(p.assistance);
    }
    expect(pax.some((p) => p.assistance === 'aisle-chair')).toBe(true);
  });

  it('draws only the kinds the mix asks for', () => {
    for (const kind of ASSISTANCE_KINDS) {
      const s = only(kind);
      const cabin = buildCabin(s.cabin);
      const pax = generatePopulation(cabin, s.population, new Rng(5));
      const kinds = new Set(pax.map((p) => p.assistance));
      kinds.delete('none');
      expect([...kinds], kind).toEqual([kind]);
    }
  });

  it('still produces somebody when the mix is dragged to nothing', () => {
    const s = structuredClone(DEFAULT_SCENARIO);
    s.population.assistanceFraction = 0.2;
    s.population.assistanceMix = {
      'aisle-chair': 0,
      'own-wheelchair': 0,
      'reduced-mobility': 0,
      minor: 0,
    };
    const pax = generatePopulation(buildCabin(s.cabin), s.population, new Rng(2));
    expect(pax.some((p) => p.needsAssistance)).toBe(true);
  });

  it('runs a scenario saved before the mix existed', () => {
    // Pins are persisted, so a scenario written without a mix has to restore.
    const s = structuredClone(DEFAULT_SCENARIO);
    delete (s.population as { assistanceMix?: unknown }).assistanceMix;
    expect(createSimulation(s).run().complete).toBe(true);
  });
});

describe('aisle-chair crew', () => {
  it('rosters escorts only for aisle-chair passengers', () => {
    for (const kind of ASSISTANCE_KINDS) {
      const sim = createSimulation(only(kind));
      const chairs = sim.agents.filter((a) => a.passenger.assistance === 'aisle-chair');
      expect(sim.crew.length, kind).toBe(
        chairs.length * DEFAULT_SCENARIO.params.escortsPerAisleChair,
      );
    }
  });

  it('takes every escort back off the aircraft', () => {
    const sim = createSimulation(only('aisle-chair'));
    expect(sim.crew.length).toBeGreaterThan(0);
    sim.run();
    expect(sim.crew.every((c) => c.state === 'ashore')).toBe(true);
    expect(sim.crew.every((c) => c.pos < 0)).toBe(true);
  });

  it('sends them aft behind the chair and forward again once it is down', () => {
    const sim = createSimulation(only('aisle-chair'));
    const seen = new Map<number, Set<string>>();
    const headings = new Map<number, Set<number>>();
    while (sim.step()) {
      for (const c of sim.crew) {
        seen.set(c.id, (seen.get(c.id) ?? new Set()).add(c.state));
        if (c.pos >= 0) headings.set(c.id, (headings.get(c.id) ?? new Set()).add(c.heading));
      }
    }
    for (const [id, states] of seen) {
      expect(states.has('escorting'), `crew ${id} never boarded`).toBe(true);
      expect(states.has('leaving'), `crew ${id} never left`).toBe(true);
      expect(states.has('ashore'), `crew ${id} never got off`).toBe(true);
      // Aft on the way in, forward on the way out: both directions, one aisle.
      expect([...(headings.get(id) ?? [])].sort(), `crew ${id} headings`).toEqual([-1, 1]);
    }
  });

  it('is not finished while an escort is still aboard', () => {
    const sim = createSimulation(only('aisle-chair'));
    while (sim.step()) {
      const snap = sim.snapshot();
      const clear = sim.crew.every((c) => c.pos < 0);
      expect(sim.done).toBe(snap.seatedCount >= snap.total && clear);
    }
    expect(sim.done).toBe(true);
  });

  it('holds the aircraft after the last passenger when a chair boards late', () => {
    // With preboarding switched off the chair takes its turn in the queue, so
    // sometimes the last thing the aircraft is waiting for is two crew members
    // walking back up an aisle full of people.
    const held = (preboard: boolean): number => {
      let n = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const s = only('aisle-chair');
        s.seed = seed;
        s.population = { ...s.population, assistanceFraction: 0.15 };
        s.boarding = { ...s.boarding, preboardAssistance: preboard };
        if (createSimulation(s).run().crewClearSeconds > 0) n++;
      }
      return n;
    };

    expect(held(false), 'the walk-out never outlasted the last passenger').toBeGreaterThan(0);
    // And this is the case for preboarding, stated as a measurement: board the
    // chairs first and the crew are always long gone before the doors close.
    expect(held(true), 'preboarding failed to clear the crew in time').toBe(0);
  });

  it('counts one transfer per aisle-chair passenger', () => {
    const sim = createSimulation(only('aisle-chair'));
    const m = sim.run();
    expect(m.crewTransfers).toBe(m.assistanceCounts['aisle-chair']);
    expect(m.crewTransfers).toBeGreaterThan(0);
  });

  it('charges both parties when crew and a boarder share a cell', () => {
    const sim = createSimulation(only('aisle-chair'));
    const m = sim.run();
    // Escorts walking out through a boarding queue must meet somebody.
    expect(m.crewPassEvents).toBeGreaterThan(0);
    expect(m.crewAboardSeconds).toBeGreaterThan(0);
  });

  it('never puts two escorts in one cell, in either lane', () => {
    const sim = createSimulation(only('aisle-chair'));
    while (sim.step()) {
      const aboard = sim.crew.filter((c) => c.pos >= 0);
      const outbound = aboard.filter((c) => c.lane === 'exit').map((c) => c.pos);
      const inbound = aboard.filter((c) => c.lane === 'aisle').map((c) => c.pos);
      expect(new Set(outbound).size).toBe(outbound.length);
      expect(new Set(inbound).size).toBe(inbound.length);
    }
  });

  it('costs more the more crew each lift takes', () => {
    const time = (escorts: number): number => {
      const s = only('aisle-chair');
      s.params = { ...s.params, escortsPerAisleChair: escorts };
      return createSimulation(s).run().totalTime;
    };
    expect(time(3)).toBeGreaterThan(time(1));
  });
});

describe('what each kind costs', () => {
  it('makes an aisle chair the most disruptive kind by some way', () => {
    const time = (kind: Exclude<AssistanceKind, 'none'>): number =>
      createSimulation(only(kind)).run().totalTime;
    const chair = time('aisle-chair');
    for (const kind of ['own-wheelchair', 'reduced-mobility', 'minor'] as const) {
      expect(chair, `${kind} was not cheaper than an aisle chair`).toBeGreaterThan(time(kind));
    }
  });

  it('leaves the cabin untouched when nobody asks for help', () => {
    const s = structuredClone(DEFAULT_SCENARIO);
    s.population.assistanceFraction = 0;
    const sim = createSimulation(s);
    expect(sim.crew.length).toBe(0);
    const m = sim.run();
    expect(m.complete).toBe(true);
    expect(m.crewTransfers).toBe(0);
    expect(m.crewClearSeconds).toBe(0);
    expect(m.assistanceCounts.none).toBe(sim.agents.length);
  });

  it('finishes even with a cabin full of aisle chairs', () => {
    // The pathological case: everybody preboards, every one of them a lift.
    const s = only('aisle-chair');
    s.population = { ...s.population, assistanceFraction: 0.15 };
    s.cabin = { ...s.cabin, rows: 12 };
    const m = createSimulation(s).run();
    expect(m.complete).toBe(true);
  });
});
