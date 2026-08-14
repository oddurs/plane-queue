import type { Cabin, Passenger, Seat } from './types.ts';

/**
 * A boarding policy as a linear score over seat features.
 *
 * Every passenger's seat is scored, and low scores board first. The point of
 * this parameterisation is that the published strategies are not special cases
 * to be enumerated — they are *points* in one continuous space:
 *
 *   back-to-front    row = -1
 *   front-to-back    row = +1
 *   outside-in       depth = -1
 *   reverse pyramid  row = -1, depth = -1
 *   Steffen          depth = -16, parity = +4, side = +2, row = -1
 *
 * Steffen's method falls out of the magnitudes. Nesting one sort inside another
 * requires the outer weight's *gap* to exceed the combined range of everything
 * below it: depth steps by |w|/2, so beating row (1) plus side (2) plus parity
 * (4) needs |w_depth| > 14.
 *
 * The seat-based strategies — outside-in, both Steffen variants — are
 * reproduced exactly. The block-based ones are approximations: back-to-front
 * and reverse pyramid sort by discrete blocks of rows, which a continuous row
 * feature can only imitate. That costs nothing here, because the optimizer
 * always scores the real strategy implementations as its baselines and uses
 * these coordinates only for seeding and for naming the nearest relative.
 */
export interface PolicyWeights {
  /** Positive boards the front first; negative boards the rear first. */
  row: number;
  /** Positive boards aisle seats first; negative boards windows first. */
  depth: number;
  /** Separates odd from even rows, which is what creates Steffen-style waves. */
  parity: number;
  /** Separates the two sides of the aisle. */
  side: number;
}

export const POLICY_KEYS: (keyof PolicyWeights)[] = ['row', 'depth', 'parity', 'side'];

/** Where each published strategy sits in the space, for seeding and comparison. */
export const NAMED_POLICIES: Record<string, PolicyWeights> = {
  'back-to-front': { row: -1, depth: 0, parity: 0, side: 0 },
  'front-to-back': { row: 1, depth: 0, parity: 0, side: 0 },
  'outside-in': { row: 0, depth: -1, parity: 0, side: 0 },
  'reverse-pyramid': { row: -1, depth: -1, parity: 0, side: 0 },
  'steffen-modified': { row: 0, depth: -4, parity: 1, side: 0 },
  'steffen-perfect': { row: -1, depth: -16, parity: 4, side: 2 },
};

/**
 * Seat features, each scaled to roughly [0, 1] so the weights are comparable
 * and a search step means the same thing along every axis.
 */
function features(seat: Seat, rows: number): PolicyWeights {
  return {
    row: rows > 1 ? (seat.row - 1) / (rows - 1) : 0,
    depth: seat.depth / 2,
    parity: seat.row % 2,
    side: seat.side === 'left' ? 0 : 1,
  };
}

export function scoreSeat(seat: Seat, rows: number, weights: PolicyWeights): number {
  const f = features(seat, rows);
  return (
    f.row * weights.row +
    f.depth * weights.depth +
    f.parity * weights.parity +
    f.side * weights.side
  );
}

/**
 * Orders passengers by policy score.
 *
 * The incoming list is assumed already shuffled, so seats that score equally
 * keep an arbitrary relative order rather than being silently sorted by seat id.
 */
export function policyOrder(
  cabin: Cabin,
  passengers: Passenger[],
  weights: PolicyWeights,
): Passenger[] {
  const rows = cabin.config.rows;
  return passengers
    .map((p, i) => ({ p, i, k: scoreSeat(p.seat, rows, weights) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.p);
}

/** Scales weights to unit length so only their relative sizes matter. */
export function normalizeWeights(w: PolicyWeights): PolicyWeights {
  const norm = Math.hypot(w.row, w.depth, w.parity, w.side);
  if (norm < 1e-9) return { row: 0, depth: -1, parity: 0, side: 0 };
  return {
    row: w.row / norm,
    depth: w.depth / norm,
    parity: w.parity / norm,
    side: w.side / norm,
  };
}

/** Euclidean distance between two policies, both normalised first. */
export function policyDistance(a: PolicyWeights, b: PolicyWeights): number {
  const x = normalizeWeights(a);
  const y = normalizeWeights(b);
  return Math.hypot(x.row - y.row, x.depth - y.depth, x.parity - y.parity, x.side - y.side);
}

/** The published strategy a policy most resembles, with its distance. */
export function nearestNamed(w: PolicyWeights): { name: string; distance: number } {
  let best = { name: 'none', distance: Infinity };
  for (const [name, named] of Object.entries(NAMED_POLICIES)) {
    const distance = policyDistance(w, named);
    if (distance < best.distance) best = { name, distance };
  }
  return best;
}

/** Plain-language reading of what a policy actually does at the gate. */
export function describePolicy(w: PolicyWeights): string {
  // Check before normalising: `normalizeWeights` substitutes a fallback for a
  // degenerate policy, which would otherwise be described as outside-in.
  if (Math.hypot(w.row, w.depth, w.parity, w.side) < 1e-9) {
    return 'no preference — effectively random';
  }
  const n = normalizeWeights(w);
  const parts: string[] = [];
  const strength = (v: number): string =>
    Math.abs(v) > 0.6 ? 'strongly' : Math.abs(v) > 0.25 ? '' : 'slightly';
  const phrase = (label: string, v: number): string =>
    [strength(v), label].filter(Boolean).join(' ');

  // Report in order of influence, so the dominant rule is named first.
  const ranked = POLICY_KEYS.map((k) => ({ k, v: n[k] })).sort(
    (a, b) => Math.abs(b.v) - Math.abs(a.v),
  );

  for (const { k, v } of ranked) {
    if (Math.abs(v) < 0.08) continue;
    if (k === 'row') parts.push(phrase(v < 0 ? 'back to front' : 'front to back', v));
    if (k === 'depth') parts.push(phrase(v < 0 ? 'windows before aisles' : 'aisles before windows', v));
    if (k === 'parity') parts.push(phrase('alternating odd and even rows', v));
    if (k === 'side') parts.push(phrase('one side of the aisle at a time', v));
  }

  return parts.length === 0 ? 'no preference — effectively random' : parts.join(', then ');
}
