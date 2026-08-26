import { describe, expect, it } from 'vitest';
import { buildCabin, seatLabel } from '../src/engine/cabin.ts';
import { generatePopulation } from '../src/engine/passengers.ts';
import {
  naturalGroups,
  orderPassengers,
  orderWithGroups,
  pickOpponent,
  STRATEGIES,
} from '../src/engine/strategies.ts';
import { buildQueue } from '../src/engine/groups.ts';
import { Rng } from '../src/engine/rng.ts';
import type { BoardingConfig, Passenger, StrategyId } from '../src/engine/types.ts';

const cabin = buildCabin({ rows: 12, firstClassRows: 0, binSlotsPerRow: 8 });

/** A full cabin, one passenger per seat, no parties — pure ordering fixture. */
function fullCabin(): Passenger[] {
  return generatePopulation(
    cabin,
    {
      loadFactor: 1,
      meanBags: 1,
      partyFraction: 0,
      assistanceFraction: 0,
      childFraction: 0,
      speedSpread: 0.25,
    },
    new Rng(1),
  );
}

function order(strategy: StrategyId, blocks = 4): Passenger[] {
  return orderPassengers(strategy, cabin, fullCabin(), { blocks }, new Rng(2));
}

const labels = (pax: Passenger[]): string[] => pax.map((p) => seatLabel(p.seat));

/** The same fixture as `order`, keeping the called groups the gate model needs. */
function withGroups(strategy: StrategyId, blocks = 4) {
  return orderWithGroups(strategy, cabin, fullCabin(), { blocks }, new Rng(2));
}

const seatsOf = (ordered: { passenger: Passenger }[]): string[] =>
  ordered.map((o) => seatLabel(o.passenger.seat));

describe('boarding strategies', () => {
  it('seats the whole cabin exactly once whatever the strategy', () => {
    const ids: StrategyId[] = [
      'random',
      'back-to-front',
      'front-to-back',
      'outside-in',
      'reverse-pyramid',
      'steffen-perfect',
      'steffen-modified',
      'premium-first',
    ];
    for (const id of ids) {
      const seats = labels(order(id));
      expect(new Set(seats).size, id).toBe(cabin.seats.length);
    }
  });

  it('Steffen perfect boards every other row, two rows apart', () => {
    // The signature wave from Figure 4 of the 2011 paper.
    expect(labels(order('steffen-perfect')).slice(0, 6)).toEqual([
      '12A',
      '10A',
      '8A',
      '6A',
      '4A',
      '2A',
    ]);
  });

  it('Steffen perfect never puts neighbouring seats next to each other in line', () => {
    const seq = order('steffen-perfect').map((p) => p.seat);
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1]!;
      const b = seq[i]!;
      if (a.side === b.side && a.depth === b.depth) {
        // Within a wave, consecutive passengers are exactly two rows apart.
        expect(Math.abs(a.row - b.row)).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('outside-in boards all windows, then middles, then aisles', () => {
    const depths = order('outside-in').map((p) => p.seat.depth);
    expect(depths.slice(0, 24).every((d) => d === 2)).toBe(true);
    expect(depths.slice(24, 48).every((d) => d === 1)).toBe(true);
    expect(depths.slice(48).every((d) => d === 0)).toBe(true);
  });

  it('back-to-front boards rear rows first and windows before aisles', () => {
    const pax = order('back-to-front', 4);
    expect(pax.slice(0, 18).every((p) => p.seat.row >= 10)).toBe(true);
    expect(pax.slice(-18).every((p) => p.seat.row <= 3)).toBe(true);
    expect(pax[0]!.seat.depth).toBe(2);
    expect(pax.at(-1)!.seat.depth).toBe(0);
  });

  it('front-to-back is back-to-front reversed by row', () => {
    const pax = order('front-to-back', 4);
    expect(pax.slice(0, 18).every((p) => p.seat.row <= 3)).toBe(true);
    expect(pax.slice(-18).every((p) => p.seat.row >= 10)).toBe(true);
  });

  it('reverse pyramid starts at the rear window and ends at the front aisle', () => {
    const pax = order('reverse-pyramid', 4);
    expect(pax[0]!.seat.row).toBeGreaterThanOrEqual(10);
    expect(pax[0]!.seat.depth).toBe(2);
    expect(pax.at(-1)!.seat.row).toBeLessThanOrEqual(3);
    expect(pax.at(-1)!.seat.depth).toBe(0);
  });

  it('premium first boards the forward cabin before economy', () => {
    const withFirst = buildCabin({ rows: 12, firstClassRows: 2, binSlotsPerRow: 8 });
    const pax = generatePopulation(
      withFirst,
      { loadFactor: 1, meanBags: 1, partyFraction: 0, assistanceFraction: 0, childFraction: 0, speedSpread: 0.25 },
      new Rng(1),
    );
    const ordered = orderPassengers('premium-first', withFirst, pax, { blocks: 4 }, new Rng(2));
    expect(ordered.slice(0, 8).every((p) => p.seat.cabinClass === 'first')).toBe(true);
    expect(ordered.slice(8).every((p) => p.seat.cabinClass === 'economy')).toBe(true);
  });
});

const boarding = (over: Partial<BoardingConfig> = {}): BoardingConfig => ({
  strategy: 'steffen-perfect',
  blocks: 4,
  releaseGroups: null,
  preboardAssistance: false,
  familiesBoardTogether: false,
  ...over,
});

describe('gate queue construction', () => {
  it('preserves the strategy order exactly when enforcement is strict', () => {
    const ordered = withGroups('steffen-perfect');
    const queue = buildQueue(ordered, boarding(), new Rng(3));
    expect(queue.map((q) => seatLabel(q.passenger.seat))).toEqual(seatsOf(ordered));
  });

  it('collapses to random boarding with a single release group', () => {
    const ordered = withGroups('steffen-perfect');
    const queue = buildQueue(ordered, boarding({ releaseGroups: 1 }), new Rng(3));
    expect(queue.every((q) => q.group === 0)).toBe(true);
    expect(queue.map((q) => seatLabel(q.passenger.seat))).not.toEqual(seatsOf(ordered));
  });

  it('keeps release groups contiguous and correctly sized', () => {
    const ordered = withGroups('outside-in');
    const queue = buildQueue(ordered, boarding({ releaseGroups: 3 }), new Rng(3));
    const groups = queue.map((q) => q.group);
    expect([...groups].sort((a, b) => a - b)).toEqual(groups);
    expect(new Set(groups).size).toBe(3);
    // Group 1 is still all window seats even though order within it is scrambled.
    expect(
      queue.filter((q) => q.group === 0).every((q) => q.passenger.seat.depth === 2),
    ).toBe(true);
  });

  it('pulls party members together in the queue', () => {
    const pax = generatePopulation(
      cabin,
      {
        loadFactor: 1,
        meanBags: 1,
        partyFraction: 0.5,
        assistanceFraction: 0,
        childFraction: 0.3,
      speedSpread: 0.25,
      },
      new Rng(9),
    );
    const ordered = orderWithGroups('steffen-perfect', cabin, pax, { blocks: 4 }, new Rng(2));
    const queue = buildQueue(ordered, boarding({ familiesBoardTogether: true }), new Rng(3));

    const positions = new Map<number, number[]>();
    queue.forEach((q, i) => {
      const id = q.passenger.partyId;
      if (id === null) return;
      positions.set(id, [...(positions.get(id) ?? []), i]);
    });
    expect(positions.size).toBeGreaterThan(3);
    for (const [, idx] of positions) {
      // Contiguous block: last index minus first equals size minus one.
      expect(idx.at(-1)! - idx[0]!).toBe(idx.length - 1);
    }
  });

  it('keeps parties together even when release groups scramble the order', () => {
    // Regression: the within-group shuffle used to move individuals, which tore
    // apart the parties keepPartiesTogether had just assembled — silently
    // disabling "families board together" whenever the gate used groups.
    const pax = generatePopulation(
      cabin,
      {
        loadFactor: 1,
        meanBags: 1,
        partyFraction: 0.6,
        assistanceFraction: 0,
        childFraction: 0.3,
      speedSpread: 0.25,
      },
      new Rng(31),
    );
    const ordered = orderWithGroups('steffen-perfect', cabin, pax, { blocks: 4 }, new Rng(2));
    const queue = buildQueue(
      ordered,
      boarding({ familiesBoardTogether: true, releaseGroups: 4 }),
      new Rng(7),
    );

    const positions = new Map<number, number[]>();
    queue.forEach((q, i) => {
      const id = q.passenger.partyId;
      if (id === null) return;
      positions.set(id, [...(positions.get(id) ?? []), i]);
    });
    expect(positions.size).toBeGreaterThan(3);

    // A party may straddle a group boundary, which legitimately splits it in
    // two; anything beyond that means the shuffle broke it up.
    for (const [, idx] of positions) {
      const groups = new Set(idx.map((i) => queue[i]!.group));
      expect(groups.size).toBeLessThanOrEqual(2);
      for (const g of groups) {
        const withinGroup = idx.filter((i) => queue[i]!.group === g);
        expect(withinGroup.at(-1)! - withinGroup[0]!).toBe(withinGroup.length - 1);
      }
    }
  });

  it('still scrambles solo passengers within a release group', () => {
    const ordered = withGroups('outside-in');
    const queue = buildQueue(
      ordered,
      boarding({ familiesBoardTogether: true, releaseGroups: 3 }),
      new Rng(3),
    );
    // The fixture has no parties, so party-atomic shuffling must not become an
    // accidental no-op that preserves the strategy order.
    expect(queue.map((q) => seatLabel(q.passenger.seat))).not.toEqual(seatsOf(ordered));
  });

  it('lifts passengers needing assistance and their party to the front', () => {
    const pax = generatePopulation(
      cabin,
      {
        loadFactor: 1,
        meanBags: 1,
        partyFraction: 0.4,
        assistanceFraction: 0.1,
        childFraction: 0.3,
      speedSpread: 0.25,
      },
      new Rng(21),
    );
    const ordered = orderWithGroups('back-to-front', cabin, pax, { blocks: 4 }, new Rng(2));
    const queue = buildQueue(ordered, boarding({ preboardAssistance: true }), new Rng(3));

    const lastPreboard = queue.findLastIndex((q) => q.group === -1);
    expect(lastPreboard).toBeGreaterThanOrEqual(0);
    // Everyone before the cut needs assistance or is travelling with someone who does.
    const preboardParties = new Set(
      queue
        .slice(0, lastPreboard + 1)
        .map((q) => q.passenger.partyId)
        .filter((id): id is number => id !== null),
    );
    for (const q of queue.slice(0, lastPreboard + 1)) {
      const p = q.passenger;
      expect(p.needsAssistance || (p.partyId !== null && preboardParties.has(p.partyId))).toBe(true);
    }
    for (const q of queue.slice(lastPreboard + 1)) {
      expect(q.passenger.needsAssistance).toBe(false);
    }
  });
});

/**
 * The gate model must reproduce a strategy exactly when the gate makes as many
 * announcements as the strategy defines, and coarsen it honestly below that.
 *
 * The failure this pins down: release groups used to be equal-sized slices of
 * the queue rather than the strategy's own groups. That is invisible whenever a
 * strategy's groups happen to be equal — blocks of rows, window/middle/aisle —
 * and destroys the ones that are not. "Premium to coach" boards a dozen
 * first-class passengers ahead of a hundred and fifty in economy, so an even
 * cut released most of economy first and the method decayed into random
 * boarding while still calling itself premium-first.
 */
describe('gate discipline', () => {
  // A real cabin: first class at 2-2 makes the strategies' groups unequal,
  // which is exactly the case the even-slice model got wrong.
  const airliner = buildCabin({ rows: 30, firstClassRows: 3, binSlotsPerRow: 8 });
  const population = {
    loadFactor: 1,
    meanBags: 1,
    partyFraction: 0,
    assistanceFraction: 0,
    childFraction: 0,
    speedSpread: 0.25,
  };
  const gate = (over: Partial<BoardingConfig> = {}): BoardingConfig => ({
    strategy: 'random',
    blocks: 4,
    releaseGroups: null,
    preboardAssistance: false,
    familiesBoardTogether: false,
    ...over,
  });

  const intended = (strategy: StrategyId, blocks = 4) =>
    orderWithGroups(
      strategy,
      airliner,
      generatePopulation(airliner, population, new Rng(1)),
      { blocks },
      new Rng(2),
    );

  /** Which of the strategy's own groups ended up in each released group. */
  function naturalPerReleased(
    ordered: ReturnType<typeof intended>,
    queue: { passenger: Passenger; group: number }[],
  ): Map<number, Set<number>> {
    const source = new Map(ordered.map((o) => [o.passenger.id, o.group]));
    const seen = new Map<number, Set<number>>();
    for (const entry of queue) {
      const set = seen.get(entry.group) ?? new Set<number>();
      set.add(source.get(entry.passenger.id) as number);
      seen.set(entry.group, set);
    }
    return seen;
  }

  it.each(STRATEGIES.map((m) => [m.id, m.id] as const))(
    '%s is reproduced group for group at its natural count',
    (_name, strategy) => {
      const ordered = intended(strategy);
      const groups = naturalGroups(strategy, { blocks: 4 });
      const queue = buildQueue(ordered, gate({ strategy, releaseGroups: groups }), new Rng(3));

      const perReleased = naturalPerReleased(ordered, queue);
      for (const [released, natural] of perReleased) {
        expect(natural.size, `released group ${released} merged ${natural.size} groups`).toBe(1);
      }
      expect(perReleased.size).toBe(new Set(ordered.map((o) => o.group)).size);
    },
  );

  it('declares the group count each strategy actually produces', () => {
    // naturalGroups feeds the control panel's default. If it drifts from what
    // the sorter really does, selecting a strategy silently mis-sets the gate.
    for (const { id } of STRATEGIES) {
      const actual = new Set(intended(id).map((o) => o.group)).size;
      const declared = naturalGroups(id, { blocks: 4 });
      if (declared === null) expect(actual, id).toBe(intended(id).length);
      else expect(declared, id).toBe(actual);
    }
  });

  it('releases the forward cabin on its own under premium to coach', () => {
    const ordered = intended('premium-first');
    const queue = buildQueue(
      ordered,
      gate({ strategy: 'premium-first', releaseGroups: 2 }),
      new Rng(3),
    );
    const firstGroup = queue.filter((q) => q.group === 0);
    expect(firstGroup.length).toBeGreaterThan(0);
    expect(firstGroup.every((q) => q.passenger.seat.cabinClass === 'first')).toBe(true);
    // And nobody from the forward cabin is left behind in the second call.
    expect(
      queue.filter((q) => q.group === 1).every((q) => q.passenger.seat.cabinClass === 'economy'),
    ).toBe(true);
  });

  it.each(STRATEGIES.map((m) => [m.id, m.id] as const))(
    '%s never splits one of its groups across two announcements',
    (_name, strategy) => {
      const ordered = intended(strategy);
      const natural = new Set(ordered.map((o) => o.group)).size;
      for (let k = 1; k <= Math.min(12, natural + 3); k++) {
        const queue = buildQueue(ordered, gate({ strategy, releaseGroups: k }), new Rng(5));
        const source = new Map(ordered.map((o) => [o.passenger.id, o.group]));

        // Every natural group lands wholly inside one released group...
        const home = new Map<number, number>();
        for (const entry of queue) {
          const g = source.get(entry.passenger.id) as number;
          const seen = home.get(g);
          if (seen === undefined) home.set(g, entry.group);
          else expect(seen, `${strategy} k=${k}: group ${g} split`).toBe(entry.group);
        }
        // ...released groups stay in order and are contiguous in the queue...
        const order = queue.map((q) => q.group);
        expect([...order].sort((a, b) => a - b), `${strategy} k=${k}`).toEqual(order);
        // ...and the gate makes as many announcements as it said it would.
        expect(new Set(order).size, `${strategy} k=${k}`).toBe(Math.min(k, natural));
      }
    },
  );

  it('collapses every strategy to one group when the gate calls once', () => {
    for (const { id } of STRATEGIES) {
      const queue = buildQueue(intended(id), gate({ strategy: id, releaseGroups: 1 }), new Rng(7));
      expect(new Set(queue.map((q) => q.group)).size, id).toBe(1);
    }
  });
});

describe('race pairings', () => {
  // A race shares its seed and its population between the lanes, so the same
  // strategy on both sides is the identical run twice — it always reported a
  // dead heat, which read as "the picker does nothing".
  it('never races a strategy against itself', () => {
    for (const { id } of STRATEGIES) {
      for (const { id: preferred } of STRATEGIES) {
        expect(pickOpponent(id, preferred), `${id} vs ${preferred}`).not.toBe(id);
      }
    }
  });

  it('leaves a valid opponent alone', () => {
    expect(pickOpponent('back-to-front', 'outside-in')).toBe('outside-in');
    expect(pickOpponent('custom', 'steffen-perfect')).toBe('steffen-perfect');
  });
});
