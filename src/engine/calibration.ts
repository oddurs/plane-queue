import { runScenario, DEFAULT_SCENARIO, type Scenario } from './run.ts';
import type { BoardingConfig } from './types.ts';

/**
 * Reproduces the experiment the engine is fitted to, so the calibration claim
 * can be checked in the app rather than taken on trust from the test suite.
 *
 * Steffen & Hotchkiss (2011) boarded 72 volunteers into a mock 757 — 12 rows of
 * six seats, one aisle, one door — once per method.
 */

export interface CalibrationRow {
  /** The published strategy name, as the 2011 paper labels it. */
  method: string;
  /** Published time in seconds. */
  measured: number;
  /** Mean simulated time in seconds. */
  simulated: number;
  /** Signed relative error, simulated vs measured. */
  error: number;
  note?: string;
}

const EXPERIMENT: Scenario = {
  ...DEFAULT_SCENARIO,
  cabin: { rows: 12, firstClassRows: 0, binSlotsPerRow: 7 },
  population: {
    loadFactor: 1.0,
    meanBags: 1.2,
    partyFraction: 0.08,
    assistanceFraction: 0,
    childFraction: 0.5,
      speedSpread: 0.25,
  },
};

/**
 * Release groups mirror how each method was actually run: Steffen and
 * back-to-front used numbered tickets giving a strict order, while Wilma,
 * blocks and random only sorted people into coarse groups.
 */
const METHODS: {
  method: string;
  measured: number;
  boarding: Partial<BoardingConfig>;
  note?: string;
}[] = [
  {
    method: 'Steffen (perfect)',
    measured: 216,
    boarding: { strategy: 'steffen-perfect', releaseGroups: null },
    note: 'Simulated faster by design: the measured run was knowingly imperfect — parent-child pairs boarded out of sequence and some passengers sat in the wrong seat.',
  },
  {
    method: 'Outside-in (WilMA)',
    measured: 253,
    boarding: { strategy: 'outside-in', releaseGroups: 3 },
  },
  {
    method: 'Random',
    measured: 284,
    boarding: { strategy: 'random', releaseGroups: 1 },
  },
  {
    method: 'Back-to-front (by row)',
    measured: 371,
    boarding: { strategy: 'back-to-front', blocks: 12, releaseGroups: null },
  },
  {
    method: 'Blocks (3 × 4 rows)',
    measured: 414,
    boarding: { strategy: 'back-to-front', blocks: 3, releaseGroups: 3 },
    note: 'The one method the model disagrees with. Larger blocks genuinely let more people stow at once, so the simulator rates this better than back-to-front by row. The experiment measured one un-replicated run per method with a stated ~10% uncertainty.',
  },
];

export function runCalibration(trials = 40): CalibrationRow[] {
  return METHODS.map(({ method, measured, boarding, note }) => {
    let total = 0;
    for (let i = 0; i < trials; i++) {
      total += runScenario({
        ...EXPERIMENT,
        boarding: {
          ...EXPERIMENT.boarding,
          preboardAssistance: false,
          familiesBoardTogether: true,
          ...boarding,
        } as BoardingConfig,
        seed: i + 1,
      }).totalTime;
    }
    const simulated = total / trials;
    return {
      method,
      measured,
      simulated,
      error: simulated / measured - 1,
      ...(note ? { note } : {}),
    };
  });
}
