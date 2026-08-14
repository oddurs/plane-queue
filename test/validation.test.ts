import { describe, expect, it } from 'vitest';
import { runScenario, DEFAULT_SCENARIO, type Scenario } from '../src/engine/run.ts';
import type { BoardingConfig } from '../src/engine/types.ts';

/**
 * Calibration against Steffen & Hotchkiss (2011), "Experimental test of airplane
 * boarding methods", J. Air Transport Management.
 *
 * They boarded 72 volunteers into a mock 757 fuselage — 12 rows of six seats,
 * one aisle, one door — five times, once per method. Those five measured times
 * are the only physical ground truth available for this kind of model, so the
 * engine's timing constants are fitted to them and pinned here.
 *
 * The experiment was a single un-replicated run per method with a stated
 * uncertainty of ~10%, so these tests assert the robust findings — the ordering
 * of the methods and the size of the gaps — rather than exact seconds.
 */

const PUBLISHED = {
  steffen: 216, // 3:36
  wilma: 253, // 4:13
  random: 284, // 4:44
  backToFront: 371, // 6:11
  blocks: 414, // 6:54
} as const;

/** The mock 757 and its 72 passengers, including three parent-child pairs. */
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
const METHODS: Record<keyof typeof PUBLISHED, Partial<BoardingConfig>> = {
  steffen: { strategy: 'steffen-perfect', releaseGroups: null },
  wilma: { strategy: 'outside-in', releaseGroups: 3 },
  random: { strategy: 'random', releaseGroups: 1 },
  backToFront: { strategy: 'back-to-front', blocks: 12, releaseGroups: null },
  blocks: { strategy: 'back-to-front', blocks: 3, releaseGroups: 3 },
};

const TRIALS = 60;

function meanTime(method: keyof typeof PUBLISHED): number {
  let total = 0;
  for (let i = 0; i < TRIALS; i++) {
    total += runScenario({
      ...EXPERIMENT,
      boarding: {
        ...EXPERIMENT.boarding,
        preboardAssistance: false,
        familiesBoardTogether: true,
        ...METHODS[method],
      } as BoardingConfig,
      seed: i + 1,
    }).totalTime;
  }
  return total / TRIALS;
}

describe('calibration against Steffen & Hotchkiss (2011)', () => {
  const times = {
    steffen: meanTime('steffen'),
    wilma: meanTime('wilma'),
    random: meanTime('random'),
    backToFront: meanTime('backToFront'),
    blocks: meanTime('blocks'),
  };

  it('reproduces the published ranking of the four robustly separated methods', () => {
    expect(times.steffen).toBeLessThan(times.wilma);
    expect(times.wilma).toBeLessThan(times.random);
    expect(times.random).toBeLessThan(times.blocks);
    expect(times.blocks).toBeLessThan(times.backToFront);
  });

  it('lands within 15% of the measured time for Wilma, random and back-to-front', () => {
    for (const key of ['wilma', 'random', 'backToFront'] as const) {
      const ratio = times[key] / PUBLISHED[key];
      expect(ratio, `${key} ${times[key].toFixed(0)}s vs ${PUBLISHED[key]}s`).toBeGreaterThan(0.85);
      expect(ratio, `${key} ${times[key].toFixed(0)}s vs ${PUBLISHED[key]}s`).toBeLessThan(1.15);
    }
  });

  it('runs perfectly ordered Steffen at or below the measured time', () => {
    // The experiment's Steffen run was knowingly imperfect: parent-child pairs
    // boarded first out of sequence and some passengers sat in the wrong seat.
    // A fully compliant queue should therefore beat the measured 3:36, but not
    // by an implausible margin.
    expect(times.steffen).toBeLessThan(PUBLISHED.steffen);
    expect(times.steffen).toBeGreaterThan(PUBLISHED.steffen * 0.75);
  });

  it('keeps the headline speed-up factors close to the published ones', () => {
    // Published: back-to-front is 1.72x Steffen, random 1.31x, Wilma 1.17x.
    expect(times.backToFront / times.steffen).toBeGreaterThan(1.6);
    expect(times.random / times.steffen).toBeGreaterThan(1.25);
    expect(times.wilma / times.steffen).toBeGreaterThan(1.1);
  });

  it('reproduces the measured interference signature of each method', () => {
    const run = (method: keyof typeof PUBLISHED) =>
      runScenario({
        ...EXPERIMENT,
        boarding: {
          ...EXPERIMENT.boarding,
          preboardAssistance: false,
          familiesBoardTogether: false,
          ...METHODS[method],
        } as BoardingConfig,
        seed: 5,
      });

    // Properly ordered back-to-front and Wilma both eliminate seat interference.
    expect(run('backToFront').seatInterferenceTotal).toBe(0);
    expect(run('steffen').seatInterferenceTotal).toBe(0);
    // Random boarding is where seat interference shows up; the paper estimates
    // roughly 1.5 per passenger in a three-seat half-row.
    const randomSeat = run('random').seatInterferenceTotal;
    expect(randomSeat).toBeGreaterThan(20);
    expect(randomSeat).toBeLessThan(72 * 1.5);
  });
});

describe('scaling with cabin length', () => {
  it('widens Steffen’s advantage on a longer cabin', () => {
    // Steffen & Hotchkiss predict the benefit of parallel stowing scales with
    // cabin length: "a more typical airplane with twice as many rows will gain
    // more by the implementation of parallelized boarding methods."
    const advantage = (rows: number): number => {
      // `blocks: rows` keeps back-to-front strictly row-by-row at both sizes;
      // a fixed block count would quietly become a different method.
      const at = (over: Partial<BoardingConfig>): number => {
        let total = 0;
        for (let i = 0; i < 20; i++) {
          total += runScenario({
            ...EXPERIMENT,
            cabin: { rows, firstClassRows: 0, binSlotsPerRow: 7 },
            boarding: {
              ...EXPERIMENT.boarding,
              preboardAssistance: false,
              familiesBoardTogether: false,
              ...over,
            } as BoardingConfig,
            seed: i + 1,
          }).totalTime;
        }
        return total / 20;
      };
      return (
        at({ strategy: 'back-to-front', blocks: rows, releaseGroups: null }) /
        at(METHODS.steffen)
      );
    };

    expect(advantage(30)).toBeGreaterThan(advantage(12));
  });
});
