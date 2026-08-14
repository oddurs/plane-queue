import { runScenario, type Scenario } from './run.ts';
import { strategyName } from './strategies.ts';
import { AIRCRAFT_TYPES } from './aircraft.ts';
import {
  formatDuration,
  measure,
  noiseBand,
  type Measurement,
} from './stats.ts';

/**
 * The bench: runs kept aside so they can be argued about.
 *
 * Everything else in this app measures, reports, and forgets — move a slider
 * and the previous answer is gone. That makes it a calculator. An instrument
 * lets you hold two experiments side by side and ask whether the difference
 * between them is real, which is what this is for.
 *
 * A pin is never a single run. Pinning samples the scenario properly, so a
 * saved result carries its own spread and can be compared under the same
 * significance rule as every other claim on the page.
 */

export interface Pin {
  id: string;
  label: string;
  /** Milliseconds since epoch, supplied by the caller. */
  createdAt: number;
  scenario: Scenario;
  /** Boarding time across the sampled trials. */
  time: Measurement;
  /** Mean passenger-seconds lost to being stuck behind someone. */
  blockedSeconds: number;
  /** Trials that hit the simulation's time cap and are therefore not results. */
  incompleteRuns: number;
}

/**
 * A short, human description of what makes this scenario what it is.
 *
 * It has to distinguish two experiments that differ, or the bench lists
 * identical-looking rows with different numbers beside them. Every knob that
 * changes behaviour appears; the population fractions are abbreviated so the
 * line stays readable.
 */
export function describeScenario(scenario: Scenario): string {
  const type = AIRCRAFT_TYPES.find((t) => t.id === (scenario.cabin.typeId ?? 'a320'));
  const { population: pop, boarding, cabin } = scenario;
  const gate = boarding.releaseGroups === null ? 'strict' : `${boarding.releaseGroups} groups`;
  const seats = cabin.rows * 6 - cabin.firstClassRows * 2;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;

  const parts = [
    (type?.name ?? 'aircraft').replace(/^(Airbus|Boeing) /, ''),
    `${cabin.rows}r`,
    `${Math.round(seats * pop.loadFactor)} pax`,
    strategyName(boarding.strategy),
    gate,
    `${pop.meanBags.toFixed(1)} bags`,
    `${pct(pop.partyFraction)} parties`,
  ];
  if (pop.partyFraction > 0) parts.push(`${pct(pop.childFraction)} kids`);
  if (pop.assistanceFraction > 0) parts.push(`${pct(pop.assistanceFraction)} assist`);
  if (!boarding.familiesBoardTogether) parts.push('families split');
  if (!boarding.preboardAssistance) parts.push('no preboard');
  return parts.join(' · ');
}

export interface PinRequest {
  scenario: Scenario;
  trials: number;
  createdAt: number;
  /** Optional user label; the scenario description is used when absent. */
  label?: string;
}

export function createPin(request: PinRequest): Pin {
  const { scenario, trials, createdAt } = request;
  let blockedSeconds = 0;
  let incompleteRuns = 0;

  const time = measure(
    (seed) => {
      const metrics = runScenario({ ...scenario, seed });
      blockedSeconds += metrics.totalBlockedSeconds;
      if (!metrics.complete) incompleteRuns++;
      return metrics.totalTime;
    },
    trials,
    scenario.seed,
  );

  return {
    // Deterministic given the inputs, and unique enough for a local bench.
    id: `${createdAt.toString(36)}-${Math.round(time.mean * 100).toString(36)}`,
    label: request.label?.trim() || describeScenario(scenario),
    createdAt,
    scenario: structuredClone(scenario),
    time,
    blockedSeconds: blockedSeconds / Math.max(1, trials),
    incompleteRuns,
  };
}

export interface PinComparison {
  faster: Pin;
  slower: Pin;
  gapSeconds: number;
  /** Two standard errors of the difference. */
  band: number;
  significant: boolean;
  verdict: string;
}

/**
 * Compares two pinned runs.
 *
 * Held to exactly the standard the findings panel and the optimizer use: a gap
 * smaller than the noise band is reported as unproven rather than as a result.
 * Two scenarios measured on separate occasions deserve more scepticism than
 * two strategies measured on shared seeds, not less.
 */
export function comparePins(a: Pin, b: Pin): PinComparison | null {
  if (a.id === b.id) return null;

  const faster = a.time.mean <= b.time.mean ? a : b;
  const slower = faster === a ? b : a;
  const gapSeconds = slower.time.mean - faster.time.mean;
  const band = noiseBand(faster.time, slower.time);
  const significant = gapSeconds > band;

  const capped = a.incompleteRuns + b.incompleteRuns;
  const verdict = capped
    ? `Not comparable — ${capped} of the sampled runs hit the simulator's time cap, so at least one of these is not a measurement.`
    : significant
      ? `${faster.label} is faster by ${formatDuration(gapSeconds)}, against a ±${band.toFixed(0)}s noise band. A real difference.`
      : `No measurable difference. The ${formatDuration(gapSeconds)} gap sits inside the ±${band.toFixed(0)}s noise band — not something you could rely on.`;

  return { faster, slower, gapSeconds, band, significant, verdict };
}
