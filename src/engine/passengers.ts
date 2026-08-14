import type { Cabin, Passenger, PopulationConfig, Seat } from './types.ts';
import type { Rng } from './rng.ts';

/**
 * Builds the passenger manifest: who is flying, how much they are carrying,
 * who they are travelling with, and where they sit.
 *
 * Parties are seated adjacently, which is what makes "families board together"
 * a genuine constraint rather than a cosmetic one — a fine-grained order like
 * Steffen's deliberately separates neighbouring seats in the queue, so keeping
 * a family together necessarily breaks it.
 */

/** Party sizes drawn for group travellers, weighted toward pairs. */
const PARTY_SIZES = [2, 2, 2, 3, 3, 4, 5];

interface FreeSeatIndex {
  /** Free seats per row, split by side and ordered aisle-outward. */
  byRowSide: Map<string, Seat[]>;
}

function key(row: number, side: string): string {
  return `${row}:${side}`;
}

function buildFreeIndex(seats: Seat[]): FreeSeatIndex {
  const byRowSide = new Map<string, Seat[]>();
  for (const seat of seats) {
    const k = key(seat.row, seat.side);
    const list = byRowSide.get(k);
    if (list) list.push(seat);
    else byRowSide.set(k, [seat]);
  }
  for (const list of byRowSide.values()) list.sort((a, b) => a.depth - b.depth);
  return { byRowSide };
}

/**
 * Claims `count` seats for one party, preferring seats that are together:
 * first a single half-row, then both halves of one row, then anywhere.
 */
function claimSeats(
  index: FreeSeatIndex,
  count: number,
  rowOrder: number[],
  rng: Rng,
): Seat[] {
  const sides = ['left', 'right'];

  // Contiguous within one half-row.
  for (const row of rowOrder) {
    for (const side of sides) {
      const list = index.byRowSide.get(key(row, side));
      if (list && list.length >= count) {
        return list.splice(0, count);
      }
    }
  }

  // Split across the aisle but still in one row.
  for (const row of rowOrder) {
    const left = index.byRowSide.get(key(row, 'left')) ?? [];
    const right = index.byRowSide.get(key(row, 'right')) ?? [];
    if (left.length + right.length >= count) {
      const take = Math.min(left.length, count);
      return [...left.splice(0, take), ...right.splice(0, count - take)];
    }
  }

  // Fall back to whatever is left, nearest rows first.
  const claimed: Seat[] = [];
  for (const row of rowOrder) {
    for (const side of rng.shuffle([...sides])) {
      const list = index.byRowSide.get(key(row, side));
      while (list && list.length > 0 && claimed.length < count) {
        claimed.push(list.shift() as Seat);
      }
      if (claimed.length === count) return claimed;
    }
  }
  return claimed;
}

export function generatePopulation(
  cabin: Cabin,
  config: PopulationConfig,
  rng: Rng,
): Passenger[] {
  const total = Math.max(
    1,
    Math.min(cabin.seats.length, Math.round(cabin.seats.length * config.loadFactor)),
  );

  const index = buildFreeIndex(cabin.seats.slice());
  const rowOrder = rng.shuffle(
    Array.from({ length: cabin.config.rows }, (_, i) => i + 1),
  );

  const passengers: Passenger[] = [];
  let partyId = 0;
  let nextId = 0;

  // Seat travelling parties first so they can still find adjacent seats.
  const partyTarget = Math.round(total * config.partyFraction);
  let inParties = 0;
  while (inParties < partyTarget && passengers.length < total) {
    const wanted = PARTY_SIZES[rng.int(PARTY_SIZES.length)] as number;
    const size = Math.min(wanted, total - passengers.length, partyTarget - inParties + 1);
    if (size < 2) break;

    const seats = claimSeats(index, size, rowOrder, rng);
    if (seats.length < 2) break;

    const id = partyId++;
    seats.forEach((seat, i) => {
      // Every party has at least one adult, so seat 0 is never a child.
      const isChild = i > 0 && rng.bool(config.childFraction);
      passengers.push(makePassenger(nextId++, seat, id, isChild, config, rng));
    });
    inParties += seats.length;
  }

  // Then solo travellers into whatever is left.
  const remaining: Seat[] = [];
  for (const list of index.byRowSide.values()) remaining.push(...list);
  rng.shuffle(remaining);

  for (const seat of remaining) {
    if (passengers.length >= total) break;
    passengers.push(makePassenger(nextId++, seat, null, false, config, rng));
  }

  return passengers;
}

function makePassenger(
  id: number,
  seat: Seat,
  partyId: number | null,
  isChild: boolean,
  config: PopulationConfig,
  rng: Rng,
): Passenger {
  const MAX_BAGS = 3;
  const draw = (): number => rng.binomial(MAX_BAGS, config.meanBags / MAX_BAGS);
  // Children rarely wrestle a roll-aboard into the bin themselves.
  const bags = isChild ? Math.min(1, draw()) : draw();
  const needsAssistance = !isChild && rng.bool(config.assistanceFraction);

  // Individual pace, then the effect of being a child on top. The assistance
  // penalty lives in SimParams so it stays tunable from the interface.
  const pace = rng.logNormalUnitMean(config.speedSpread);
  const slowFactor = Math.min(2.2, Math.max(0.65, pace * (isChild ? 1.3 : 1)));

  return {
    id,
    seat,
    bags,
    partyId,
    isChild,
    needsAssistance,
    slowFactor,
  };
}
