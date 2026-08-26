import type { BoardingConfig, Passenger } from './types.ts';
import type { OrderedPassenger } from './strategies.ts';
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
  ordered: OrderedPassenger[],
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
 * member, and into that member's group — a family is called once, together.
 *
 * This is the practical objection to Steffen's method: it deliberately puts
 * neighbouring seats far apart in line, so honouring families necessarily
 * destroys the spacing that makes it fast.
 */
function keepPartiesTogether(ordered: OrderedPassenger[]): OrderedPassenger[] {
  const parties = new Map<number, OrderedPassenger[]>();
  for (const entry of ordered) {
    const { partyId } = entry.passenger;
    if (partyId === null) continue;
    const members = parties.get(partyId);
    if (members) members.push(entry);
    else parties.set(partyId, [entry]);
  }

  const emitted = new Set<number>();
  const result: OrderedPassenger[] = [];

  for (const entry of ordered) {
    if (emitted.has(entry.passenger.id)) continue;
    if (entry.passenger.partyId === null) {
      result.push(entry);
      emitted.add(entry.passenger.id);
      continue;
    }
    // First member of this party we reach drags the rest along with them, into
    // that member's group.
    for (const member of parties.get(entry.passenger.partyId) ?? [entry]) {
      result.push({ passenger: member.passenger, group: entry.group });
      emitted.add(member.passenger.id);
    }
  }

  return result;
}

/**
 * Coarsens the strategy's own called groups down to the number the gate will
 * actually announce, and shuffles within each one.
 *
 * The groups are merged at the strategy's boundaries, never at an arbitrary
 * passenger count. Slicing the queue into equal-sized chunks instead looks
 * right whenever a strategy's groups happen to be the same size — blocks of
 * rows, windows/middles/aisles — and silently destroys every strategy whose
 * groups are not. "Premium to coach" is the extreme case: a dozen first-class
 * passengers against a hundred and fifty in economy, so an even cut released
 * most of economy ahead of most of the forward cabin and the method decayed
 * into random boarding.
 *
 * This is the single knob that spans the whole spectrum of gate discipline:
 * `null` enforces the strategy exactly (as in Steffen's experiment, where
 * passengers were handed numbered tickets), while 1 group collapses any
 * strategy to random boarding. Real gates sit in between at 4-6 groups.
 */
function assignGroups(
  ordered: OrderedPassenger[],
  releaseGroups: number | null,
  rng: Rng,
  keepPartiesAtomic: boolean,
): QueueEntry[] {
  if (releaseGroups === null) {
    return ordered.map(({ passenger }, i) => ({ passenger, group: i }));
  }

  const buckets = bucketByGroup(ordered, Math.max(1, Math.floor(releaseGroups)));
  const result: QueueEntry[] = [];

  for (let g = 0; g < buckets.length; g++) {
    const chunk = buckets[g] as OrderedPassenger[];
    // Passengers queue arbitrarily within their called group — but a family
    // walks down the jetbridge as one unit, so parties shuffle as blocks.
    const units = keepPartiesAtomic
      ? contiguousParties(chunk)
      : chunk.map((entry) => [entry]);
    for (const unit of rng.shuffle(units)) {
      for (const entry of unit) result.push({ passenger: entry.passenger, group: g });
    }
  }

  return result;
}

/**
 * Merges the strategy's groups into `wanted` announcements, splitting the queue
 * as evenly as the strategy's own boundaries allow.
 *
 * A group is never divided and never merged unnecessarily: whenever the gate
 * will make at least as many announcements as the strategy defines, each group
 * is released on its own, so a strategy run at its natural group count is
 * reproduced exactly. Below that, adjacent groups are merged greedily towards
 * an equal share, and the walk is forced to close a bucket once only enough
 * groups remain to fill the ones left — otherwise a strategy with a few large
 * groups would quietly announce fewer times than the gate said it would.
 */
function bucketByGroup(ordered: OrderedPassenger[], wanted: number): OrderedPassenger[][] {
  const sizes = new Map<number, number>();
  for (const entry of ordered) sizes.set(entry.group, (sizes.get(entry.group) ?? 0) + 1);
  const groups = [...sizes].sort((a, b) => a[0] - b[0]);

  const count = Math.min(wanted, groups.length);
  const share = ordered.length / count;

  const bucketOf = new Map<number, number>();
  let bucket = 0;
  let seen = 0;
  groups.forEach(([group, size], i) => {
    bucketOf.set(group, bucket);
    seen += size;
    const groupsLeft = groups.length - i - 1;
    const bucketsLeft = count - bucket - 1;
    if (bucketsLeft > 0 && (groupsLeft <= bucketsLeft || seen >= share * (bucket + 1))) {
      bucket++;
    }
  });

  const buckets: OrderedPassenger[][] = Array.from({ length: count }, () => []);
  for (const entry of ordered) {
    (buckets[bucketOf.get(entry.group) as number] as OrderedPassenger[]).push(entry);
  }
  return buckets;
}

/**
 * Splits a chunk into runs of adjacent passengers from the same party. Relies
 * on `keepPartiesTogether` having already made each party contiguous; a party
 * straddling a group boundary simply becomes two units, which is what happens
 * at a real gate too.
 */
function contiguousParties(chunk: OrderedPassenger[]): OrderedPassenger[][] {
  const units: OrderedPassenger[][] = [];
  for (const entry of chunk) {
    const last = units.at(-1);
    const sameParty =
      last !== undefined &&
      entry.passenger.partyId !== null &&
      last[0]?.passenger.partyId === entry.passenger.partyId;
    if (sameParty) last.push(entry);
    else units.push([entry]);
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
