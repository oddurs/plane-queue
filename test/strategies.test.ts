import { describe, expect, it } from 'vitest';
import { buildCabin, seatLabel } from '../src/engine/cabin.ts';
import { generatePopulation } from '../src/engine/passengers.ts';
import { orderPassengers } from '../src/engine/strategies.ts';
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
    const ordered = order('steffen-perfect');
    const queue = buildQueue(ordered, boarding(), new Rng(3));
    expect(queue.map((q) => seatLabel(q.passenger.seat))).toEqual(labels(ordered));
  });

  it('collapses to random boarding with a single release group', () => {
    const ordered = order('steffen-perfect');
    const queue = buildQueue(ordered, boarding({ releaseGroups: 1 }), new Rng(3));
    expect(queue.every((q) => q.group === 0)).toBe(true);
    expect(queue.map((q) => seatLabel(q.passenger.seat))).not.toEqual(labels(ordered));
  });

  it('keeps release groups contiguous and correctly sized', () => {
    const ordered = order('outside-in');
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
    const ordered = orderPassengers('steffen-perfect', cabin, pax, { blocks: 4 }, new Rng(2));
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
    const ordered = orderPassengers('steffen-perfect', cabin, pax, { blocks: 4 }, new Rng(2));
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
    const ordered = order('outside-in');
    const queue = buildQueue(
      ordered,
      boarding({ familiesBoardTogether: true, releaseGroups: 3 }),
      new Rng(3),
    );
    // The fixture has no parties, so party-atomic shuffling must not become an
    // accidental no-op that preserves the strategy order.
    expect(queue.map((q) => seatLabel(q.passenger.seat))).not.toEqual(labels(ordered));
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
    const ordered = orderPassengers('back-to-front', cabin, pax, { blocks: 4 }, new Rng(2));
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
