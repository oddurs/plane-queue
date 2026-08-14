/**
 * How hard to look, said once.
 *
 * Every analysis in this app is a Monte Carlo sample, and each had grown its own
 * trial-count field: sixty for the ranking, twelve for the sweep, eight per
 * candidate for the search, twenty for a pin. Four numbers expressing one idea,
 * each demanding a decision the reader has no basis to make.
 *
 * There is one control now, and every panel derives its own budget from it. The
 * settings are named for what they buy — a quick look, a normal one, or a long
 * hard stare — rather than for the arithmetic underneath.
 */
export type Precision = 'quick' | 'standard' | 'thorough';

export interface Budget {
  /** Trials per strategy in the ranking. */
  compare: number;
  /** Trials per point on a sweep. */
  sweep: number;
  /** Candidate policies the optimizer evaluates. */
  searchCandidates: number;
  /** Trials per candidate during the search. */
  searchTrials: number;
  /** Trials behind each counterfactual in the findings. */
  findings: number;
  /** Trials behind a pinned run. */
  pin: number;
  /** Trials per method when reproducing the published experiment. */
  calibrate: number;
}

const BUDGETS: Record<Precision, Budget> = {
  quick: {
    compare: 20,
    sweep: 6,
    searchCandidates: 80,
    searchTrials: 5,
    findings: 10,
    pin: 10,
    calibrate: 20,
  },
  standard: {
    compare: 60,
    sweep: 12,
    searchCandidates: 160,
    searchTrials: 8,
    findings: 20,
    pin: 20,
    calibrate: 40,
  },
  thorough: {
    compare: 200,
    sweep: 30,
    searchCandidates: 320,
    searchTrials: 12,
    findings: 40,
    pin: 40,
    calibrate: 120,
  },
};

export const PRECISION_LABELS: Record<Precision, string> = {
  quick: 'Quick',
  standard: 'Normal',
  thorough: 'Thorough',
};

export const PRECISION_HINT: Record<Precision, string> = {
  quick: 'Fewer trials — fast, with wider noise bands.',
  standard: 'A balanced sample behind every figure.',
  thorough: 'Many more trials, so smaller differences become resolvable.',
};

export function budgetFor(precision: Precision): Budget {
  return BUDGETS[precision];
}
