import type { BoardingConfig, Passenger } from './types.ts';
import type { Rng } from './rng.ts';

/**
 * Turns an intended strategy order into the queue that actually forms at the
 * gate, applying the three real-world distortions the simulator models.
 *
 * Order matters here. Families are pulled together first (they will not be
 * separated whatever the gate says), then the order is coarsened into release
 * groups, and finally preboarders are lifted to the front.
 */

export interface QueueEntry {
  passenger: Passenger;
  group: number;
}

export function buildQueue(
  ordered: Passenger[],
  config: BoardingConfig,
  rng: Rng,
): QueueEntry[] {
  let queue = ordered;

  if (config.familiesBoardTogether) queue = keepPartiesTogether(queue);

  // When families board together the shuffle has to move them as units.
  // Shuffling individuals would tear apart the parties just assembled, which
  // would mean "families board together" quietly stopped applying the moment
  // the gate used release groups — the common case.
  const grouped = assignGroups(
    queue,
    config.releaseGroups,
    rng,
    config.familiesBoardTogether,
  );

  return config.preboardAssistance ? preboard(grouped) : grouped;
}

/**
 * Moves every member of a party to the queue position of its earliest-ordered
 * member. This is the practical objection to Steffen's method: it deliberately
 * puts neighbouring seats far apart in line, so honouring families necessarily
 * destroys the spacing that makes it fast.
 */
function keepPartiesTogether(ordered: Passenger[]): Passenger[] {
  const parties = new Map<number, Passenger[]>();
  for (const p of ordered) {
    if (p.partyId === null) continue;
    const members = parties.get(p.partyId);
    if (members) members.push(p);
    else parties.set(p.partyId, [p]);
  }

  const emitted = new Set<number>();
  const result: Passenger[] = [];

  for (const p of ordered) {
    if (emitted.has(p.id)) continue;
    if (p.partyId === null) {
      result.push(p);
      emitted.add(p.id);
      continue;
    }
    // First member of this party we reach drags the rest along with them.
    for (const member of parties.get(p.partyId) ?? [p]) {
      result.push(member);
      emitted.add(member.id);
    }
  }

  return result;
}

/**
 * Splits the queue into contiguous release groups and shuffles within each one.
 *
 * This is the single knob that spans the whole spectrum of gate discipline:
 * `null` enforces the strategy exactly (as in Steffen's experiment, where
 * passengers were handed numbered tickets), while 1 group collapses any
 * strategy to random boarding. Real gates sit in between at 4-6 groups.
 */
function assignGroups(
  ordered: Passenger[],
  releaseGroups: number | null,
  rng: Rng,
  keepPartiesAtomic: boolean,
): QueueEntry[] {
  if (releaseGroups === null || releaseGroups >= ordered.length) {
    return ordered.map((passenger, i) => ({ passenger, group: i }));
  }

  const groups = Math.max(1, Math.floor(releaseGroups));
  const size = Math.ceil(ordered.length / groups);
  const result: QueueEntry[] = [];

  for (let g = 0; g < groups; g++) {
    const chunk = ordered.slice(g * size, (g + 1) * size);
    if (chunk.length === 0) break;
    // Passengers queue arbitrarily within their called group — but a family
    // walks down the jetbridge as one unit, so parties shuffle as blocks.
    const units = keepPartiesAtomic ? contiguousParties(chunk) : chunk.map((p) => [p]);
    for (const unit of rng.shuffle(units)) {
      for (const passenger of unit) result.push({ passenger, group: g });
    }
  }

  return result;
}

/**
 * Splits a chunk into runs of adjacent passengers from the same party. Relies
 * on `keepPartiesTogether` having already made each party contiguous; a party
 * straddling a group boundary simply becomes two units, which is what happens
 * at a real gate too.
 */
function contiguousParties(chunk: Passenger[]): Passenger[][] {
  const units: Passenger[][] = [];
  for (const passenger of chunk) {
    const last = units.at(-1);
    const sameParty =
      last !== undefined &&
      passenger.partyId !== null &&
      last[0]?.partyId === passenger.partyId;
    if (sameParty) last.push(passenger);
    else units.push([passenger]);
  }
  return units;
}

/**
 * Lifts passengers needing assistance — and anyone travelling with them — to
 * the head of the queue, preserving their relative order.
 */
function preboard(queue: QueueEntry[]): QueueEntry[] {
  const preboardParties = new Set<number>();
  for (const { passenger } of queue) {
    if (passenger.needsAssistance && passenger.partyId !== null) {
      preboardParties.add(passenger.partyId);
    }
  }

  const isPreboard = (p: Passenger): boolean =>
    p.needsAssistance || (p.partyId !== null && preboardParties.has(p.partyId));

  const first: QueueEntry[] = [];
  const rest: QueueEntry[] = [];
  for (const entry of queue) {
    if (isPreboard(entry.passenger)) first.push({ ...entry, group: -1 });
    else rest.push(entry);
  }

  return [...first, ...rest];
}
