import { describe, expect, it } from 'vitest';
import { buildCabin, seatLabel } from '../src/engine/cabin.ts';
import { generatePopulation } from '../src/engine/passengers.ts';
import { orderPassengers } from '../src/engine/strategies.ts';
import { Rng } from '../src/engine/rng.ts';
import {
  NAMED_POLICIES,
  describePolicy,
  nearestNamed,
  normalizeWeights,
  policyOrder,
  type PolicyWeights,
} from '../src/engine/policy.ts';
import { optimizePolicy } from '../src/engine/optimize.ts';
import { DEFAULT_SCENARIO, runScenario, type Scenario } from '../src/engine/run.ts';
import type { StrategyId } from '../src/engine/types.ts';

const cabin = buildCabin({ rows: 12, firstClassRows: 0, binSlotsPerRow: 8 });

function fullCabin() {
  return generatePopulation(
    cabin,
    { loadFactor: 1, meanBags: 1, partyFraction: 0, assistanceFraction: 0, childFraction: 0, speedSpread: 0.25 },
    new Rng(1),
  );
}

/** Same shuffled input both ways, so only the ordering rule differs. */
function compareOrderings(id: StrategyId, weights: PolicyWeights): [string[], string[]] {
  const pax = fullCabin();
  const viaStrategy = orderPassengers(id, cabin, pax, { blocks: 12 }, new Rng(2));
  const shuffled = orderPassengers('random', cabin, pax, { blocks: 12 }, new Rng(2));
  const viaPolicy = policyOrder(cabin, shuffled, weights);
  return [viaStrategy.map((p) => seatLabel(p.seat)), viaPolicy.map((p) => seatLabel(p.seat))];
}

describe('policy space', () => {
  // These three sort purely on seat attributes, so the linear score reproduces
  // them exactly. The block-based strategies cannot be — see below.
  it.each(['outside-in', 'steffen-modified', 'steffen-perfect'] as const)(
    'reproduces %s exactly',
    (id) => {
      const [strategy, policy] = compareOrderings(id, NAMED_POLICIES[id]!);
      expect(policy).toEqual(strategy);
    },
  );

  it('only approximates the block-based strategies', () => {
    // back-to-front sorts by discrete blocks of rows; a continuous row feature
    // cannot express that, and the optimizer never relies on it being able to.
    const [strategy, policy] = compareOrderings('back-to-front', NAMED_POLICIES['back-to-front']!);
    expect(policy).not.toEqual(strategy);
    // It should still board the rear before the front.
    const rearFirst = policy.slice(0, 12).every((s) => Number(s.slice(0, -1)) >= 10);
    expect(rearFirst).toBe(true);
  });

  it('normalises to unit length and keeps direction', () => {
    const n = normalizeWeights({ row: -2, depth: -4, parity: 0, side: 0 });
    expect(Math.hypot(n.row, n.depth, n.parity, n.side)).toBeCloseTo(1, 6);
    expect(n.depth / n.row).toBeCloseTo(2, 6);
  });

  it('falls back to a sane policy when all weights are zero', () => {
    const n = normalizeWeights({ row: 0, depth: 0, parity: 0, side: 0 });
    expect(Math.hypot(n.row, n.depth, n.parity, n.side)).toBeCloseTo(1, 6);
  });

  it('identifies each named policy as nearest to itself', () => {
    for (const [name, weights] of Object.entries(NAMED_POLICIES)) {
      const nearest = nearestNamed(weights);
      expect(nearest.name, name).toBe(name);
      expect(nearest.distance, name).toBeCloseTo(0, 6);
    }
  });

  it('describes policies in plain language', () => {
    expect(describePolicy(NAMED_POLICIES['outside-in']!)).toContain('windows before aisles');
    expect(describePolicy(NAMED_POLICIES['back-to-front']!)).toContain('back to front');
    expect(describePolicy(NAMED_POLICIES['front-to-back']!)).toContain('front to back');
    expect(describePolicy({ row: 0, depth: 0, parity: 0, side: 0 })).toContain('random');
  });
});

describe('policy optimizer', () => {
  // A small cabin keeps the search cheap enough to run in the suite.
  const scenario: Scenario = {
    ...DEFAULT_SCENARIO,
    cabin: { rows: 12, firstClassRows: 0, binSlotsPerRow: 7 },
    population: {
      loadFactor: 1,
      meanBags: 1.2,
      partyFraction: 0,
      assistanceFraction: 0,
      childFraction: 0,
      speedSpread: 0.25,
    },
    boarding: {
      ...DEFAULT_SCENARIO.boarding,
      releaseGroups: null,
      preboardAssistance: false,
      familiesBoardTogether: false,
    },
  };

  const result = optimizePolicy(scenario, { iterations: 40, trials: 5, seed: 4242 });

  it('returns a normalised policy and a full convergence history', () => {
    expect(Math.hypot(...Object.values(result.weights))).toBeCloseTo(1, 6);
    expect(result.history).toHaveLength(40);
    expect(result.baselines).toHaveLength(8);
  });

  it('never lets the best-so-far score get worse', () => {
    for (let i = 1; i < result.history.length; i++) {
      expect(result.history[i]!).toBeLessThanOrEqual(result.history[i - 1]!);
    }
  });

  it('reports a held-out score separate from the search score', () => {
    expect(result.validationTrials).toBeGreaterThanOrEqual(24);
    expect(result.mean).toBeGreaterThan(0);
    expect(result.trainMean).toBeGreaterThan(0);
    // The search optimises the training seeds, so it should not do better on
    // fresh ones by any meaningful margin.
    expect(result.trainMean).toBeLessThan(result.mean * 1.05);
  });

  it('finds a policy at least competitive with the best named strategy', () => {
    const best = result.baselines[0]!;
    expect(result.mean).toBeLessThan(best.mean * 1.02);
  });

  it('only calls a win significant when it clears the noise band', () => {
    const best = result.baselines[0]!;
    expect(result.marginStdError).toBeGreaterThan(0);
    expect(result.significant).toBe(best.mean - result.mean > 2 * result.marginStdError);
    // Every baseline should carry a spread; a zero would mean the held-out
    // trials were not actually varying.
    for (const b of result.baselines) expect(b.sd, b.name).toBeGreaterThan(0);
  });

  it('produces weights that actually drive the simulation', () => {
    // Running the discovered policy through the normal path must reproduce the
    // optimizer's own evaluation, not silently fall back to a default.
    const viaCustom = runScenario({
      ...scenario,
      boarding: { ...scenario.boarding, strategy: 'custom', customWeights: result.weights },
      seed: 777,
    }).totalTime;
    const viaOutsideIn = runScenario({
      ...scenario,
      boarding: { ...scenario.boarding, strategy: 'custom' },
      seed: 777,
    }).totalTime;
    // The fallback is plain outside-in; a discovered policy should differ from it.
    expect(viaCustom).not.toBe(viaOutsideIn);
  });

  it('is deterministic for a given seed', () => {
    const again = optimizePolicy(scenario, { iterations: 40, trials: 5, seed: 4242 });
    expect(again.weights).toEqual(result.weights);
    expect(again.mean).toBe(result.mean);
  });

  it('honours the gate constraint it was given', () => {
    const constrained = optimizePolicy(
      { ...scenario, boarding: { ...scenario.boarding, releaseGroups: 3 } },
      { iterations: 20, trials: 4, seed: 11 },
    );
    expect(constrained.releaseGroups).toBe(3);
    // Coarse gate groups discard ordering information, so the reachable optimum
    // is strictly worse than under a strictly ordered queue.
    expect(constrained.mean).toBeGreaterThan(result.mean);
  });
});
