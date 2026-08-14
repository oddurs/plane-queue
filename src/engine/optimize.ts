import { runScenario, type Scenario } from './run.ts';
import { Rng } from './rng.ts';
import {
  NAMED_POLICIES,
  POLICY_KEYS,
  describePolicy,
  nearestNamed,
  normalizeWeights,
  type PolicyWeights,
} from './policy.ts';
import { STRATEGIES } from './strategies.ts';
import { isImprovement, measure as sample, noiseBand, type Measurement } from './stats.ts';
import type { StrategyId } from './types.ts';

/**
 * Searches the policy space for the fastest boarding order under the scenario's
 * *actual* constraints.
 *
 * Steffen (2008) found his optimum with a Markov Chain Monte Carlo search over
 * an idealised model — no families, no gate groups, no assistance. This does the
 * same kind of search, but against the full simulator, so the answer respects
 * whatever the user has switched on. That is the interesting part: with families
 * boarding together and only four gate groups, the reachable optimum is not
 * Steffen's method, and no published work says what it is.
 *
 * Two details make the search behave:
 *
 *  - **Common random numbers.** Every candidate is scored on the same fixed set
 *    of seeds, so the objective is deterministic in the weights. Without this
 *    the search chases simulation noise instead of real improvements.
 *  - **Normalised weights.** Only the ratios between weights matter, so each
 *    candidate is projected back onto the unit sphere and step sizes stay
 *    meaningful throughout.
 */

export interface OptimizeOptions {
  /** Candidate policies to evaluate. */
  iterations: number;
  /** Boardings averaged per candidate. */
  trials: number;
  seed: number;
}

export const DEFAULT_OPTIMIZE_OPTIONS: OptimizeOptions = {
  iterations: 160,
  trials: 8,
  seed: 12345,
};

export interface OptimizeProgress {
  iteration: number;
  iterations: number;
  /** Best objective so far, in seconds. */
  best: number;
  /** Objective of the candidate just evaluated. */
  current: number;
}

/** A named strategy scored on the held-out seeds. Carries its own spread so the
 * margin against it can be significance-tested like any other comparison. */
export interface BaselineResult extends Measurement {
  strategy: StrategyId;
  name: string;
}

export interface OptimizeResult {
  weights: PolicyWeights;
  /**
   * Mean boarding time on *held-out* seeds the search never saw. This is the
   * honest number: the search inspects hundreds of candidates against a small
   * fixed sample, so its own best score is optimistically biased by selection.
   */
  mean: number;
  /** Score on the search seeds. Compare with `mean` to see the overfit gap. */
  trainMean: number;
  description: string;
  nearest: { name: string; distance: number };
  /** Every named strategy, scored on the same held-out seeds as `mean`. */
  baselines: BaselineResult[];
  /** Best objective after each iteration, for the convergence chart. */
  history: number[];
  /** Whether the gate enforced a strict order during the search. */
  releaseGroups: number | null;
  /** Boardings averaged for the held-out estimate. */
  validationTrials: number;
  /**
   * Standard error of the *difference* between the discovered policy and the
   * best named strategy. A margin smaller than about twice this is not
   * distinguishable from run-to-run variation, however tempting it looks.
   */
  marginStdError: number;
  /** True when the margin clears twice its standard error. */
  significant: boolean;
}

/** Mean and spread of boarding time over a fixed set of evaluation seeds. */
function measure(
  scenario: Scenario,
  strategy: StrategyId,
  weights: PolicyWeights | undefined,
  trials: number,
  baseSeed: number,
): Measurement {
  return sample(
    (seed) =>
      runScenario({
        ...scenario,
        boarding: {
          ...scenario.boarding,
          strategy,
          ...(weights ? { customWeights: weights } : {}),
        },
        seed,
      }).totalTime,
    trials,
    baseSeed,
  );
}

function evaluate(
  scenario: Scenario,
  strategy: StrategyId,
  weights: PolicyWeights | undefined,
  trials: number,
  baseSeed: number,
): number {
  return measure(scenario, strategy, weights, trials, baseSeed).mean;
}

/** Gaussian sample via Box-Muller, for the annealing proposal step. */
function gaussian(rng: Rng): number {
  const u = Math.max(rng.next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

function perturb(w: PolicyWeights, sigma: number, rng: Rng): PolicyWeights {
  const next = { ...w };
  for (const key of POLICY_KEYS) next[key] = w[key] + gaussian(rng) * sigma;
  return normalizeWeights(next);
}

export function optimizePolicy(
  scenario: Scenario,
  options: OptimizeOptions = DEFAULT_OPTIMIZE_OPTIONS,
  onProgress?: (p: OptimizeProgress) => void,
): OptimizeResult {
  const { iterations, trials, seed } = options;
  const rng = new Rng(seed);
  // Fixed across every candidate — this is the common-random-numbers trick.
  const evalSeed = seed + 1;
  // Disjoint from the search seeds: `trials` of them are consumed above.
  const holdoutSeed = evalSeed + trials + 1000;
  const validationTrials = Math.max(24, trials * 3);

  // Score the published strategies on the search seeds, to pick a sensible
  // starting point. The reported baselines are re-scored on held-out seeds
  // below, so the final comparison is like-for-like with the winner.
  const searchBaselines = STRATEGIES.map((meta) => ({
    strategy: meta.id,
    mean: evaluate(scenario, meta.id, undefined, trials, evalSeed),
  })).sort((a, b) => a.mean - b.mean);

  const startFrom = searchBaselines[0]?.strategy ?? 'outside-in';
  let current = normalizeWeights(
    NAMED_POLICIES[startFrom] ?? { row: 0, depth: -1, parity: 0, side: 0 },
  );
  let currentScore = evaluate(scenario, 'custom', current, trials, evalSeed);

  let best = current;
  let bestScore = currentScore;
  const history: number[] = [];

  // Temperature is expressed in seconds so the acceptance rule is interpretable:
  // early on the search will accept a candidate ~T seconds worse.
  const T0 = Math.max(4, currentScore * 0.03);
  const T1 = 0.15;

  for (let i = 0; i < iterations; i++) {
    const progress = iterations <= 1 ? 1 : i / (iterations - 1);
    const temperature = T0 * Math.pow(T1 / T0, progress);
    // Anneal the step size too: broad exploration first, fine tuning later.
    const sigma = 0.55 * (1 - progress) + 0.06;

    const candidate = perturb(current, sigma, rng);
    const score = evaluate(scenario, 'custom', candidate, trials, evalSeed);

    const delta = score - currentScore;
    if (delta <= 0 || rng.next() < Math.exp(-delta / temperature)) {
      current = candidate;
      currentScore = score;
    }
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }

    history.push(bestScore);
    onProgress?.({ iteration: i + 1, iterations, best: bestScore, current: score });
  }

  // Re-score the winner and every baseline on seeds the search never touched.
  // Without this the reported margin is inflated by however many candidates
  // were tried — the more thorough the search, the worse the bias.
  const baselines: BaselineResult[] = STRATEGIES.map((meta) => ({
    strategy: meta.id,
    name: meta.name,
    ...measure(scenario, meta.id, undefined, validationTrials, holdoutSeed),
  })).sort((a, b) => a.mean - b.mean);

  const held = measure(scenario, 'custom', best, validationTrials, holdoutSeed);
  const rival = baselines[0];
  // The two estimates share their seeds, which makes them positively correlated
  // and this a conservative (over-large) error bar. Erring toward "not proven"
  // is the right direction for a search that has already peeked at the data.
  const marginStdError = rival ? noiseBand(held, rival) / 2 : 0;

  return {
    weights: best,
    mean: held.mean,
    trainMean: bestScore,
    description: describePolicy(best),
    nearest: nearestNamed(best),
    baselines,
    history,
    releaseGroups: scenario.boarding.releaseGroups,
    validationTrials,
    marginStdError,
    significant: rival !== undefined && isImprovement(rival, held),
  };
}
