import type { Cabin, Passenger, StrategyId } from './types.ts';
import type { Rng } from './rng.ts';
import { policyOrder, type PolicyWeights } from './policy.ts';

/**
 * Boarding-order generators. Each returns the full passenger list in the order
 * the airline intends people to board.
 *
 * Depth convention from cabin.ts: 0 = aisle seat, 1 = middle, 2 = window.
 */

export interface StrategyOptions {
  blocks: number;
  /** Seat-scoring weights, required only by the 'custom' strategy. */
  weights?: PolicyWeights;
}

export interface StrategyMeta {
  id: StrategyId;
  name: string;
  blurb: string;
}

export const STRATEGIES: StrategyMeta[] = [
  {
    id: 'random',
    name: 'Random',
    blurb:
      'Assigned seats, no boarding order. The baseline every study measures against — and better than most block schemes, because it spreads passengers along the cabin so several can stow luggage at once.',
  },
  {
    id: 'back-to-front',
    name: 'Back to front',
    blurb:
      'Rear blocks first. The intuitive choice and one of the worst performers: it concentrates everyone in one part of the cabin, so only one or two people can stow at a time.',
  },
  {
    id: 'front-to-back',
    name: 'Front to back',
    blurb:
      'Front blocks first. Every passenger must walk past a fully occupied section. Steffen & Hotchkiss expected it to be roughly as bad as back-to-front.',
  },
  {
    id: 'outside-in',
    name: 'Outside-in (WilMA)',
    blurb:
      'All windows, then all middles, then all aisles. Eliminates seat interference entirely. Measured at 4:13 against back-to-front’s 6:11.',
  },
  {
    id: 'reverse-pyramid',
    name: 'Reverse pyramid',
    blurb:
      'Diagonal wave: rear windows first, front aisles last. Blends outside-in with back-to-front. America West deployed it and cut boarding by ~20% on full flights.',
  },
  {
    id: 'steffen-perfect',
    name: 'Steffen (perfect)',
    blurb:
      'Adjacent passengers in line sit two rows apart, same side, window to aisle. Maximises simultaneous luggage stowing. Fastest method measured — 3:36 — but requires strict ordering at the gate.',
  },
  {
    id: 'steffen-modified',
    name: 'Steffen (modified)',
    blurb:
      'The practical version: six groups formed from window/middle/aisle crossed with odd/even rows. Keeps most of the parallel-stowing benefit without demanding a strict per-passenger queue.',
  },
  {
    id: 'premium-first',
    name: 'Premium to coach',
    blurb:
      'First class and priority tiers first, then economy at random. What most airlines actually do — it optimises for revenue and status, not for time.',
  },
];

/**
 * Display name for any strategy id, including 'custom', which is deliberately
 * absent from `STRATEGIES` so it never appears in automatic comparisons.
 */
export function strategyName(id: StrategyId): string {
  if (id === 'custom') return 'Discovered policy';
  return STRATEGIES.find((s) => s.id === id)?.name ?? id;
}

/**
 * A passenger in intended boarding order, tagged with the group the gate would
 * call them in.
 *
 * The group is what makes a strategy deployable: an airline calls "group 3", it
 * does not hand out 165 numbered tickets. Carrying it alongside the order lets
 * the gate model coarsen the queue at the strategy's own boundaries instead of
 * guessing where they fall.
 */
export interface OrderedPassenger {
  passenger: Passenger;
  /** The strategy's own called group, numbered densely from 0 in board order. */
  group: number;
}

type Sorter = (
  cabin: Cabin,
  passengers: Passenger[],
  opts: StrategyOptions,
) => OrderedPassenger[];

/**
 * Orders passengers by the group the gate calls them in, refining ties with
 * `within` and then by incoming (randomised) order.
 *
 * Groups come back renumbered densely from 0, so callers can treat the count as
 * the number of announcements the gate has to make.
 */
function byGroup(
  passengers: Passenger[],
  group: (p: Passenger) => number,
  within: (p: Passenger) => number = () => 0,
): OrderedPassenger[] {
  const sorted = passengers
    .map((p, i) => ({ p, i, g: group(p), w: within(p) }))
    .sort((a, b) => a.g - b.g || a.w - b.w || a.i - b.i);

  const result: OrderedPassenger[] = [];
  let previous: number | null = null;
  let dense = -1;
  for (const entry of sorted) {
    if (previous === null || entry.g !== previous) dense++;
    previous = entry.g;
    result.push({ passenger: entry.p, group: dense });
  }
  return result;
}

/** Every passenger their own group: a strictly ordered, numbered queue. */
function strictOrder(passengers: Passenger[]): OrderedPassenger[] {
  return passengers.map((passenger, group) => ({ passenger, group }));
}

/** Which block a row falls into, counting from the rear. */
function blockFromRear(row: number, rows: number, blocks: number): number {
  const size = Math.ceil(rows / blocks);
  return Math.floor((rows - row) / size);
}

const SORTERS: Record<StrategyId, Sorter> = {
  random: (_cabin, passengers) => byGroup(passengers, () => 0),

  // Within a block, window seats are still called before aisle seats — that is
  // how the method is defined when run properly, and it is why Steffen &
  // Hotchkiss recorded zero seat interferences for it. Coarsening the queue
  // below one group per block is what destroys that ordering in practice.
  'back-to-front': (cabin, passengers, opts) =>
    byGroup(
      passengers,
      (p) => blockFromRear(p.seat.row, cabin.config.rows, opts.blocks),
      (p) => 2 - p.seat.depth,
    ),

  'front-to-back': (cabin, passengers, opts) => {
    const size = Math.ceil(cabin.config.rows / opts.blocks);
    return byGroup(
      passengers,
      (p) => Math.floor((p.seat.row - 1) / size),
      (p) => 2 - p.seat.depth,
    );
  },

  // Window (depth 2) first, then middle, then aisle: three announcements.
  'outside-in': (_cabin, passengers) => byGroup(passengers, (p) => 2 - p.seat.depth),

  /**
   * Reverse pyramid: board along diagonals running from the rear window to the
   * front aisle. The row block and the seat depth summed into one key give the
   * characteristic wave (van den Briel et al., 2005), and each diagonal band is
   * one called group.
   */
  'reverse-pyramid': (cabin, passengers, opts) =>
    byGroup(
      passengers,
      (p) =>
        blockFromRear(p.seat.row, cabin.config.rows, opts.blocks) + (2 - p.seat.depth),
    ),

  /**
   * Steffen's optimum. Passengers board in a strict sequence in which
   * neighbours in line are two rows apart in the same seat column, so each has
   * clear space to work at the bins.
   *
   * Nesting matches the paper's Figure 4: seat depth (window, then middle, then
   * aisle) outermost, then row parity, then side, then rows from the rear. That
   * produces waves of six — 12A, 10A, 8A, 6A, 4A, 2A — exactly two rows apart.
   *
   * Every passenger is their own group: the method only works from a numbered
   * queue, which is precisely the objection to it.
   */
  'steffen-perfect': (cabin, passengers) => {
    const rows = cabin.config.rows;
    const ordered = byGroup(passengers, (p) => {
      const { row, side, depth } = p.seat;
      const depthRank = 2 - depth; // window first
      const sideRank = side === 'left' ? 0 : 1;
      const parity = row % 2 === rows % 2 ? 0 : 1; // last row's parity boards first
      const position = rows - row; // later rows board earlier within a wave
      return ((depthRank * 2 + parity) * 2 + sideRank) * (rows + 1) + position;
    });
    return strictOrder(ordered.map((o) => o.passenger));
  },

  /**
   * The gate-practical variant: six called groups, window/middle/aisle crossed
   * with odd/even rows. Order inside a group does not matter, which is exactly
   * why it survives contact with real passengers.
   */
  'steffen-modified': (_cabin, passengers) =>
    byGroup(passengers, (p) => (2 - p.seat.depth) * 2 + (p.seat.row % 2)),

  // Two announcements: the forward cabin and priority tiers, then everyone.
  'premium-first': (_cabin, passengers) =>
    byGroup(passengers, (p) => (p.seat.cabinClass === 'first' ? 0 : 1)),

  // Driven by weights the optimizer discovered; falls back to outside-in if
  // asked to run without any. Like Steffen's optimum it is a numbered queue.
  custom: (cabin, passengers, opts) =>
    strictOrder(
      policyOrder(cabin, passengers, opts.weights ?? { row: 0, depth: -1, parity: 0, side: 0 }),
    ),
};

/**
 * The order a strategy intends, with each passenger tagged by called group.
 *
 * This is what the gate model consumes; `orderPassengers` is the same thing
 * with the groups dropped, for callers that only care about the sequence.
 */
export function orderWithGroups(
  strategy: StrategyId,
  cabin: Cabin,
  passengers: Passenger[],
  opts: StrategyOptions,
  rng: Rng,
): OrderedPassenger[] {
  // Shuffle first so that every tie inside a strategy breaks randomly rather
  // than by seat id, which would fake an ordering the airline never imposed.
  const shuffled = rng.shuffle([...passengers]);
  const sorter = SORTERS[strategy];
  return sorter(cabin, shuffled, opts);
}

export function orderPassengers(
  strategy: StrategyId,
  cabin: Cabin,
  passengers: Passenger[],
  opts: StrategyOptions,
  rng: Rng,
): Passenger[] {
  return orderWithGroups(strategy, cabin, passengers, opts, rng).map((o) => o.passenger);
}

/**
 * Picks the strategy to race `strategy` against, keeping `preferred` if it can.
 *
 * Both lanes run the same seed and the same population, so a strategy raced
 * against itself is not a close result — it is the identical run twice, and the
 * verdict reads "dead heat". The opponent therefore can never be lane A.
 */
export function pickOpponent(strategy: StrategyId, preferred: StrategyId): StrategyId {
  if (preferred !== strategy) return preferred;
  const fallback = STRATEGIES.find((meta) => meta.id !== strategy);
  return fallback?.id ?? preferred;
}

/**
 * Natural number of gate groups a strategy implies, used as the default for the
 * order-enforcement control. Steffen's optimum only works fully ordered.
 */
export function naturalGroups(strategy: StrategyId, opts: StrategyOptions): number | null {
  switch (strategy) {
    case 'random':
      return 1;
    case 'back-to-front':
    case 'front-to-back':
      return opts.blocks;
    case 'outside-in':
      return 3;
    case 'reverse-pyramid':
      return opts.blocks + 2;
    case 'steffen-modified':
      return 6;
    case 'premium-first':
      return 2;
    case 'steffen-perfect':
    case 'custom':
      return null; // strict order
  }
}
