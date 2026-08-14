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

type Sorter = (cabin: Cabin, passengers: Passenger[], opts: StrategyOptions) => Passenger[];

/** Stable sort by a numeric key; ties keep their incoming (randomised) order. */
function byKey(passengers: Passenger[], key: (p: Passenger) => number): Passenger[] {
  return passengers
    .map((p, i) => ({ p, i, k: key(p) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.p);
}

/** Which block a row falls into, counting from the rear. */
function blockFromRear(row: number, rows: number, blocks: number): number {
  const size = Math.ceil(rows / blocks);
  return Math.floor((rows - row) / size);
}

const SORTERS: Record<StrategyId, Sorter> = {
  random: (_cabin, passengers) => passengers,

  // Within a block, window seats are still called before aisle seats — that is
  // how the method is defined when run properly, and it is why Steffen &
  // Hotchkiss recorded zero seat interferences for it. Coarsening the queue
  // with release groups is what destroys that ordering in practice.
  'back-to-front': (cabin, passengers, opts) =>
    byKey(
      passengers,
      (p) =>
        blockFromRear(p.seat.row, cabin.config.rows, opts.blocks) * 3 + (2 - p.seat.depth),
    ),

  'front-to-back': (cabin, passengers, opts) => {
    const size = Math.ceil(cabin.config.rows / opts.blocks);
    return byKey(
      passengers,
      (p) => Math.floor((p.seat.row - 1) / size) * 3 + (2 - p.seat.depth),
    );
  },

  // Window (depth 2) first, then middle, then aisle.
  'outside-in': (_cabin, passengers) => byKey(passengers, (p) => -p.seat.depth),

  /**
   * Reverse pyramid: board along diagonals running from the rear window to the
   * front aisle. Combining the row block and the seat depth into one key gives
   * the characteristic wave (van den Briel et al., 2005).
   */
  'reverse-pyramid': (cabin, passengers, opts) =>
    byKey(
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
   */
  'steffen-perfect': (cabin, passengers) => {
    const rows = cabin.config.rows;
    return byKey(passengers, (p) => {
      const { row, side, depth } = p.seat;
      const depthRank = 2 - depth; // window first
      const sideRank = side === 'left' ? 0 : 1;
      const parity = row % 2 === rows % 2 ? 0 : 1; // last row's parity boards first
      const position = rows - row; // later rows board earlier within a wave
      return ((depthRank * 2 + parity) * 2 + sideRank) * (rows + 1) + position;
    });
  },

  /**
   * The gate-practical variant: six called groups, window/middle/aisle crossed
   * with odd/even rows. Order inside a group does not matter, which is exactly
   * why it survives contact with real passengers.
   */
  'steffen-modified': (_cabin, passengers) =>
    byKey(passengers, (p) => (2 - p.seat.depth) * 2 + (p.seat.row % 2)),

  'premium-first': (_cabin, passengers) =>
    byKey(passengers, (p) => (p.seat.cabinClass === 'first' ? 0 : 1)),

  // Driven by weights the optimizer discovered; falls back to outside-in if
  // asked to run without any.
  custom: (cabin, passengers, opts) =>
    policyOrder(cabin, passengers, opts.weights ?? { row: 0, depth: -1, parity: 0, side: 0 }),
};

export function orderPassengers(
  strategy: StrategyId,
  cabin: Cabin,
  passengers: Passenger[],
  opts: StrategyOptions,
  rng: Rng,
): Passenger[] {
  // Shuffle first so that every tie inside a strategy breaks randomly rather
  // than by seat id, which would fake an ordering the airline never imposed.
  const shuffled = rng.shuffle([...passengers]);
  const sorter = SORTERS[strategy];
  return sorter(cabin, shuffled, opts);
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
