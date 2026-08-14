import { runScenario, type Scenario } from './run.ts';
import { naturalGroups, STRATEGIES } from './strategies.ts';
import type { StrategyId } from './types.ts';

/** Marker value meaning "strict order" on the release-groups sweep axis. */
export const STRICT_ORDER = -1;

/**
 * Headless Monte Carlo.
 *
 * A single boarding run is noisy — Steffen & Hotchkiss put the uncertainty on
 * their own one-shot measurements at roughly 10% — so any claim about which
 * strategy is fastest has to come from a distribution, not from one animation.
 */

export interface StrategyResult {
  strategy: StrategyId;
  name: string;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  meanAisleTime: number;
  stallEvents: number;
  seatInterferences: number;
  /** Mean passenger-seconds lost to being stuck behind someone. */
  blockedSeconds: number;
  /** Seated count over time from a representative (median-length) run. */
  curve: { t: number; seated: number }[];
  /**
   * Trials that hit the simulation's time cap without seating everyone. Any
   * value above zero means the medians here are not boarding times.
   */
  incompleteRuns: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i] as number;
}

/**
 * Runs every strategy `trials` times under one scenario.
 *
 * Each strategy is evaluated on the identical set of seeds, so they face the
 * same passengers, bags and seat assignments — only the queue order differs.
 * `useNaturalGroups` applies each strategy's realistic gate-group count rather
 * than whatever the live view is set to, which is the fairer comparison when
 * asking what an airline could actually deploy.
 */
export function compareStrategies(
  scenario: Scenario,
  trials: number,
  useNaturalGroups: boolean,
): StrategyResult[] {
  return STRATEGIES.map((meta) => {
    const runs: { time: number; curve: { t: number; seated: number }[] }[] = [];
    let aisleTime = 0;
    let stallEvents = 0;
    let seatInterferences = 0;
    let blockedSeconds = 0;
    let incompleteRuns = 0;

    const releaseGroups = useNaturalGroups
      ? naturalGroups(meta.id, { blocks: scenario.boarding.blocks })
      : scenario.boarding.releaseGroups;

    for (let i = 0; i < trials; i++) {
      const metrics = runScenario({
        ...scenario,
        boarding: { ...scenario.boarding, strategy: meta.id, releaseGroups },
        seed: scenario.seed + i,
      });
      if (!metrics.complete) incompleteRuns++;
      runs.push({ time: metrics.totalTime, curve: metrics.curve });
      aisleTime += metrics.meanAisleTime;
      stallEvents += metrics.stallEvents;
      seatInterferences += metrics.seatInterferenceTotal;
      blockedSeconds += metrics.totalBlockedSeconds;
    }

    runs.sort((a, b) => a.time - b.time);
    const times = runs.map((r) => r.time);
    // Show the curve from the median run rather than an average of curves,
    // which would smooth away the shape that distinguishes the strategies.
    const representative = runs[Math.floor(runs.length / 2)];

    return {
      strategy: meta.id,
      name: meta.name,
      median: quantile(times, 0.5),
      p25: quantile(times, 0.25),
      p75: quantile(times, 0.75),
      min: times[0] as number,
      max: times.at(-1) as number,
      meanAisleTime: aisleTime / trials,
      stallEvents: stallEvents / trials,
      seatInterferences: seatInterferences / trials,
      blockedSeconds: blockedSeconds / trials,
      curve: representative?.curve ?? [],
      incompleteRuns,
    };
  }).sort((a, b) => a.median - b.median);
}

// ---- sensitivity sweeps -----------------------------------------------------

export type SweepParam =
  | 'meanBags'
  | 'loadFactor'
  | 'partyFraction'
  | 'assistanceFraction'
  | 'releaseGroups';

export interface SweepAxis {
  param: SweepParam;
  label: string;
  blurb: string;
  values: number[];
  format: (v: number) => string;
}

/**
 * The axes worth sweeping — the conditions under which a strategy's advantage
 * appears or evaporates. A ranking that holds at one operating point is not a
 * recommendation; a ranking that survives the sweep is.
 */
export const SWEEP_AXES: SweepAxis[] = [
  {
    param: 'meanBags',
    label: 'Carry-on bags',
    blurb:
      'Boarding time is dominated by luggage. With no bags to stow, order barely matters; the gaps open as bags pile up.',
    values: [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4],
    format: (v) => v.toFixed(1),
  },
  {
    param: 'releaseGroups',
    label: 'Gate release groups',
    blurb:
      'How finely the gate enforces order. Every strategy converges on random boarding at one group — fine-grained methods need the discipline to pay off.',
    values: [1, 2, 3, 4, 6, 9, 12, STRICT_ORDER],
    format: (v) => (v === STRICT_ORDER ? 'strict' : String(v)),
  },
  {
    param: 'loadFactor',
    label: 'Load factor',
    blurb:
      'Empty seats absorb interference. Differences between strategies grow sharply as the aircraft fills.',
    values: [0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    param: 'partyFraction',
    label: 'Travelling in a party',
    blurb:
      'Families board together, overriding the queue. This is what erodes Steffen’s ordering — watch its line converge toward the rest.',
    values: [0, 0.2, 0.4, 0.6, 0.8],
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    param: 'assistanceFraction',
    label: 'Needing assistance',
    blurb:
      'Preboarding holds the main queue while slower passengers reach their seats — a fixed cost paid by every strategy alike.',
    values: [0, 0.02, 0.05, 0.1, 0.15],
    format: (v) => `${(v * 100).toFixed(0)}%`,
  },
];

function applySweep(scenario: Scenario, param: SweepParam, value: number): Scenario {
  const next: Scenario = {
    ...scenario,
    population: { ...scenario.population },
    boarding: { ...scenario.boarding },
  };
  if (param === 'releaseGroups') {
    next.boarding.releaseGroups = value === STRICT_ORDER ? null : value;
  } else {
    next.population[param] = value;
  }
  return next;
}

export interface SweepSeries {
  strategy: StrategyId;
  name: string;
  /** Median boarding time at each value of the swept parameter. */
  medians: number[];
}

/**
 * Results carry the axis `param` rather than the axis object: the axis holds a
 * `format` function, which cannot cross a worker boundary. The caller looks the
 * full axis back up from `SWEEP_AXES`.
 */
export interface SweepResult {
  param: SweepParam;
  series: SweepSeries[];
}

export function findAxis(param: SweepParam): SweepAxis {
  const axis = SWEEP_AXES.find((a) => a.param === param);
  if (!axis) throw new Error(`unknown sweep axis: ${param}`);
  return axis;
}

/**
 * Runs every strategy across every value of one parameter.
 *
 * Outside the release-groups sweep each strategy uses its own realistic gate
 * grouping, so the comparison reflects what an airline could actually deploy
 * rather than an idealised queue only one method could achieve.
 */
export function sweepParameter(
  scenario: Scenario,
  axis: SweepAxis,
  trials: number,
): SweepResult {
  const series: SweepSeries[] = STRATEGIES.map((meta) => ({
    strategy: meta.id,
    name: meta.name,
    medians: [],
  }));

  for (const value of axis.values) {
    const point = applySweep(scenario, axis.param, value);

    for (const s of series) {
      const releaseGroups =
        axis.param === 'releaseGroups'
          ? point.boarding.releaseGroups
          : naturalGroups(s.strategy, { blocks: point.boarding.blocks });

      const times: number[] = [];
      for (let t = 0; t < trials; t++) {
        times.push(
          runScenario({
            ...point,
            boarding: { ...point.boarding, strategy: s.strategy, releaseGroups },
            // Every strategy sees the same seeds, so at each sweep point they
            // board identical passengers and only the ordering differs.
            seed: scenario.seed + t,
          }).totalTime,
        );
      }
      times.sort((a, b) => a - b);
      s.medians.push(quantile(times, 0.5));
    }
  }

  return { param: axis.param, series };
}
