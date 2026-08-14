import { runScenario, type Scenario } from './run.ts';
import { compareStrategies } from './batch.ts';
import { strategyName } from './strategies.ts';
import { computeEquity, describeEquity } from './equity.ts';
import {
  formatDuration,
  measure as sample,
  noiseBand,
  type Measurement,
} from './stats.ts';
import type { StrategyId } from './types.ts';

/**
 * Turns the simulator into something that reports rather than merely computes.
 *
 * Everything here is a counterfactual measured at the user's *current*
 * operating point: change one thing, re-run, report the difference. That makes
 * each finding actionable — it names a lever and what pulling it is worth —
 * rather than restating what the charts already show.
 *
 * Effects are only reported when they clear roughly twice the standard error of
 * the difference. Boarding is noisy enough that an unqualified "this saves 20
 * seconds" is often just variance wearing a hat.
 */

export type InsightKind = 'verdict' | 'lever' | 'observation';

export interface Insight {
  id: string;
  kind: InsightKind;
  title: string;
  detail: string;
  /** Seconds saved, where the finding is a lever. Negative means it costs time. */
  savingSeconds?: number;
  /**
   * Measured for information, not proposed as a course of action. Keeps the UI
   * from styling "stop accommodating people who need help" as a win.
   */
  advisory?: boolean;
}

export interface AnalysisResult {
  insights: Insight[];
  /**
   * True when any run in this analysis hit the simulation's time cap. The
   * findings below are then comparisons between non-measurements, so the panel
   * says so instead of reporting them.
   */
  truncated: boolean;
  /** Trials behind each estimate, so the UI can say how hard it looked. */
  trials: number;
  /** Boarding time under the current settings and strategy. */
  baseline: number;
  /** Fastest strategy here, so the UI can offer to switch to it. */
  bestStrategy: StrategyId | null;
  /** True when the user is already on the fastest strategy. */
  alreadyBest: boolean;
}

function measure(scenario: Scenario, trials: number, baseSeed: number): Measurement {
  return sample((seed) => runScenario({ ...scenario, seed }).totalTime, trials, baseSeed);
}


/** One thing the operator could change, and how to express it in a scenario. */
interface Lever {
  id: string;
  /** Only offered when the change is available from where the user is now. */
  applicable: (s: Scenario) => boolean;
  label: (s: Scenario) => string;
  apply: (s: Scenario) => Scenario;
  /** Extra context appended when the lever turns out to matter. */
  note?: string;
  /** Reported so the cost is known, not offered as a recommendation. */
  advisory?: boolean;
}

const LEVERS: Lever[] = [
  {
    id: 'strict-order',
    applicable: (s) => s.boarding.releaseGroups !== null,
    label: (s) => `enforcing a strict queue instead of ${s.boarding.releaseGroups} gate groups`,
    apply: (s) => ({ ...s, boarding: { ...s.boarding, releaseGroups: null } }),
    note: 'Requires ordering passengers individually at the gate, which is a real operational cost.',
  },
  {
    id: 'fewer-bags',
    applicable: (s) => s.population.meanBags >= 0.4,
    label: () => 'persuading passengers to carry half a bag less each',
    apply: (s) => ({
      ...s,
      population: { ...s.population, meanBags: Math.max(0, s.population.meanBags - 0.5) },
    }),
    note: 'Gate-checking bags or charging for carry-ons buys this directly.',
  },
  {
    id: 'more-bins',
    applicable: (s) => s.cabin.binSlotsPerRow < 12,
    label: () => 'fitting larger overhead bins (two more bag slots per row)',
    apply: (s) => ({
      ...s,
      cabin: { ...s.cabin, binSlotsPerRow: s.cabin.binSlotsPerRow + 2 },
    }),
  },
  {
    id: 'split-families',
    applicable: (s) => s.boarding.familiesBoardTogether,
    label: () => 'making families board separately',
    apply: (s) => ({ ...s, boarding: { ...s.boarding, familiesBoardTogether: false } }),
    note: 'Measured so the cost is known, not proposed — splitting up families at the gate is its own kind of expensive.',
    advisory: true,
  },
  {
    id: 'no-preboard',
    applicable: (s) => s.boarding.preboardAssistance && s.population.assistanceFraction > 0,
    label: () => 'dropping the assistance preboard',
    apply: (s) => ({ ...s, boarding: { ...s.boarding, preboardAssistance: false } }),
    note: 'Reported for completeness, not as a suggestion. Preboarding exists so passengers who need help reach their seat without a queue behind them.',
    advisory: true,
  },
];

export function analyzeScenario(scenario: Scenario, trials = 20): AnalysisResult {
  const insights: Insight[] = [];
  const seed = scenario.seed + 5000;

  // ---- how much is on the table from strategy choice alone ----
  const ranking = compareStrategies(scenario, trials, true);
  const truncated =
    ranking.some((r) => r.incompleteRuns > 0) ||
    !runScenario({ ...scenario, seed }).complete;
  const best = ranking[0];
  const worst = ranking.at(-1);
  const current = ranking.find((r) => r.strategy === scenario.boarding.strategy);

  const baseline = measure(scenario, trials, seed);

  // A configuration the model cannot finish produces comparisons between
  // capped values, where every option looks identical for the wrong reason.
  // Say that plainly rather than publishing the coincidence as a finding.
  if (truncated) {
    return {
      insights: [
        {
          id: 'truncated',
          kind: 'verdict',
          title: 'This setup is beyond what the model can simulate',
          detail:
            `Boarding did not finish inside the simulator's ${Math.round(
              scenario.params.maxSimSeconds / 60,
            )}-minute safety cap, so every number here would be that cap rather ` +
            `than a boarding time. Reduce the load, the bag count or the row ` +
            `count until a run completes.`,
        },
      ],
      trials,
      baseline: baseline.mean,
      bestStrategy: null,
      alreadyBest: false,
      truncated: true,
    };
  }


  if (best && worst) {
    const spread = worst.median - best.median;
    const relative = spread / best.median;
    const place = current ? ranking.indexOf(current) + 1 : null;

    if (relative < 0.08) {
      insights.push({
        id: 'strategy-irrelevant',
        kind: 'verdict',
        title: 'Boarding order barely matters here',
        detail:
          `Best and worst strategies are only ${formatDuration(spread)} apart (${(relative * 100).toFixed(0)}%). ` +
          `Under these conditions the queue is not your bottleneck — look at the levers below instead.`,
      });
    } else {
      insights.push({
        id: 'strategy-matters',
        kind: 'verdict',
        title: `${best.name} is fastest here, by ${formatDuration(spread)} over the worst option`,
        detail:
          `Best ${formatDuration(best.median)}, worst ${formatDuration(worst.median)} — a ${(relative * 100).toFixed(0)}% spread. ` +
          (place && current
            ? place === 1
              ? 'You are already using it.'
              : `You are using ${strategyName(scenario.boarding.strategy)}, ranked ${place} of ${ranking.length}, ` +
                `costing ${formatDuration(current.median - best.median)}.`
            : ''),
      });
    }
  }

  // ---- clock time versus human waiting ----
  if (best && worst && worst.blockedSeconds > 0 && best.blockedSeconds > 0) {
    const clockRatio = worst.median / best.median;
    const delayRatio = worst.blockedSeconds / best.blockedSeconds;
    if (delayRatio > clockRatio * 1.3) {
      insights.push({
        id: 'delay-vs-clock',
        kind: 'observation',
        title: 'The worst strategy is far worse for passengers than for the schedule',
        detail:
          `${worst.name} takes ${clockRatio.toFixed(2)}× as long as ${best.name} on the clock, but costs ` +
          `${delayRatio.toFixed(1)}× as much passenger waiting ` +
          `(${Math.round(worst.blockedSeconds / 60)} against ${Math.round(best.blockedSeconds / 60)} passenger-minutes). ` +
          `Total boarding time understates what people actually experience.`,
      });
    }
  }

  // ---- who bears the delay ----
  const equityMetrics = runScenario({ ...scenario, seed });
  const equity = computeEquity(equityMetrics.waits, scenario.cabin.rows);
  if (equity.byZone.length > 0 && equity.worstTenthShare > 0) {
    const zones = [...equity.byZone].sort((a, b) => b.meanWait - a.meanWait);
    const heaviest = zones[0];
    const lightest = zones.at(-1);
    // Only worth saying when the burden is genuinely lopsided; an even spread
    // is the unremarkable case.
    if (heaviest && lightest && heaviest.meanWait > lightest.meanWait * 1.5) {
      insights.push({
        id: 'who-waits',
        kind: 'observation',
        title: `${heaviest.label} passengers absorb most of the waiting`,
        detail:
          `${describeEquity(equity)} Total boarding time says nothing about this ` +
          `— a strategy can be quick precisely because it lets most people walk ` +
          `straight to their seat while a few stand through the whole thing.`,
      });
    }
  }

  // ---- bin pressure ----
  const binSearches = runScenario({ ...scenario, seed }).binSearches;
  const boarded = Math.round(
    scenario.population.loadFactor *
      (scenario.cabin.rows * 6 - scenario.cabin.firstClassRows * 2),
  );
  if (binSearches > boarded * 0.1) {
    insights.push({
      id: 'bin-pressure',
      kind: 'observation',
      title: 'Overhead space is running out',
      detail:
        `${binSearches} passengers had to hunt for a bin away from their own row, each blocking the ` +
        `aisle while they did. At this level, bin capacity is competing with boarding order for the blame.`,
    });
  }

  // ---- levers, ranked by what they are worth ----
  for (const lever of LEVERS) {
    if (!lever.applicable(scenario)) continue;
    const changed = measure(lever.apply(scenario), trials, seed);
    const saving = baseline.mean - changed.mean;
    const band = noiseBand(baseline, changed);

    if (Math.abs(saving) < band) {
      insights.push({
        id: lever.id,
        kind: 'lever',
        title: `${capitalize(lever.label(scenario))} changes nothing measurable`,
        detail: `Any effect is inside the ±${band.toFixed(0)}s noise band over ${trials} boardings.`,
        savingSeconds: 0,
        ...(lever.advisory ? { advisory: true } : {}),
      });
      continue;
    }

    insights.push({
      id: lever.id,
      kind: 'lever',
      title:
        saving > 0
          ? `${capitalize(lever.label(scenario))} would save ${formatDuration(saving)}`
          : `${capitalize(lever.label(scenario))} would cost ${formatDuration(-saving)}`,
      detail:
        `${formatDuration(baseline.mean)} → ${formatDuration(changed.mean)} ` +
        `(±${band.toFixed(0)}s over ${trials} boardings).` +
        (lever.note ? ` ${lever.note}` : ''),
      savingSeconds: saving,
      ...(lever.advisory ? { advisory: true } : {}),
    });
  }

  // Biggest genuine win first; inconclusive levers sink to the bottom.
  const order: Record<InsightKind, number> = { verdict: 0, observation: 1, lever: 2 };
  insights.sort((a, b) => {
    if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
    return Math.abs(b.savingSeconds ?? 0) - Math.abs(a.savingSeconds ?? 0);
  });

  return {
    insights,
    trials,
    baseline: baseline.mean,
    truncated: false,
    bestStrategy: best?.strategy ?? null,
    alreadyBest: best?.strategy === scenario.boarding.strategy,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
