import { describe, expect, it } from 'vitest';
import { CONTROL_SPECS, GATE_RANGES } from '../src/ui/controls.ts';
import { AIRCRAFT_TYPES } from '../src/engine/aircraft.ts';
import { STRATEGIES } from '../src/engine/strategies.ts';
import { PRESETS } from '../src/engine/presets.ts';
import { createSimulation, DEFAULT_SCENARIO, type Scenario } from '../src/engine/run.ts';
import { computeEquity } from '../src/engine/equity.ts';
import type { Metrics, StrategyId } from '../src/engine/types.ts';

/**
 * Every configuration the UI can produce must produce a sound run.
 *
 * The controls are a nine-slider space crossed with eight strategies, two
 * aircraft and three toggles, and the failure mode that matters is not a crash
 * — it is a run that quietly ends with people still standing, or a statistic
 * that comes back NaN and gets rendered as a number. So the sweep asserts
 * soundness, not particular times.
 *
 * The ranges come from the control specs themselves, so a slider whose bounds
 * are widened is swept at its new extremes without anyone remembering to update
 * this file.
 */

const ALL_STRATEGIES = STRATEGIES.map((s) => s.id);

/** Everything a caller could read off a finished run, checked for sanity. */
function assertSound(scenario: Scenario, label: string): Metrics {
  const sim = createSimulation(scenario);
  const expected = sim.agents.length;
  const metrics = sim.run();

  expect(expected, `${label}: empty cabin`).toBeGreaterThan(0);
  expect(metrics.complete, `${label}: run did not finish`).toBe(true);
  expect(metrics.totalTime, `${label}: totalTime`).toBeGreaterThan(0);
  expect(Number.isFinite(metrics.totalTime), `${label}: totalTime finite`).toBe(true);

  // Everyone who boarded sat down, and the curve agrees with the roster.
  expect(metrics.waits.length, `${label}: waits`).toBe(expected);
  expect(metrics.aisleTimes.length, `${label}: aisleTimes`).toBe(expected);
  expect(metrics.curve.at(-1)?.seated, `${label}: curve endpoint`).toBe(expected);

  const scalars = {
    stallEvents: metrics.stallEvents,
    seatInterferenceTotal: metrics.seatInterferenceTotal,
    binSearches: metrics.binSearches,
    gateChecked: metrics.gateChecked,
    meanAisleTime: metrics.meanAisleTime,
    medianAisleTime: metrics.medianAisleTime,
    totalBlockedSeconds: metrics.totalBlockedSeconds,
  };
  for (const [name, v] of Object.entries(scalars)) {
    expect(Number.isFinite(v), `${label}: ${name} is ${v}`).toBe(true);
    expect(v, `${label}: ${name} negative`).toBeGreaterThanOrEqual(0);
  }
  for (const t of metrics.aisleTimes) {
    expect(Number.isFinite(t), `${label}: aisle time ${t}`).toBe(true);
  }

  // The congestion grid is drawn directly, so a NaN here paints nothing.
  expect(metrics.congestion.data.length, `${label}: congestion size`).toBe(
    metrics.congestion.rows * metrics.congestion.buckets,
  );
  for (const v of metrics.congestion.data) {
    expect(Number.isFinite(v), `${label}: congestion cell`).toBe(true);
  }
  expect(Number.isFinite(metrics.congestion.peak), `${label}: congestion peak`).toBe(true);

  // And the equity panel derives from the same run.
  const equity = computeEquity(metrics.waits, scenario.cabin.rows);
  expect(Number.isFinite(equity.gini), `${label}: gini`).toBe(true);
  expect(equity.gini, `${label}: gini range`).toBeGreaterThanOrEqual(0);
  expect(equity.gini, `${label}: gini range`).toBeLessThanOrEqual(1);
  for (const [name, v] of Object.entries({
    median: equity.median,
    p90: equity.p90,
    worstTenth: equity.worstTenth,
    worstTenthShare: equity.worstTenthShare,
  })) {
    expect(Number.isFinite(v), `${label}: equity.${name} is ${v}`).toBe(true);
  }

  return metrics;
}

describe('presets', () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))('%s runs as shipped', (_id, preset) => {
    assertSound(preset.scenario, preset.id);
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))(
    '%s runs under every strategy',
    (_id, preset) => {
      for (const strategy of ALL_STRATEGIES) {
        assertSound(
          { ...preset.scenario, boarding: { ...preset.scenario.boarding, strategy } },
          `${preset.id}/${strategy}`,
        );
      }
    },
  );

  it('reproduces the published ordering in the calibration preset', () => {
    // The Steffen preset exists to be checked against the paper, so if it stops
    // ranking the way the experiment did, that preset has lost its point.
    const base = PRESETS.find((p) => p.id === 'steffen-2011')!.scenario;
    const timeOf = (strategy: StrategyId): number => {
      let total = 0;
      for (let seed = 1; seed <= 15; seed++) {
        total += createSimulation({
          ...base,
          boarding: { ...base.boarding, strategy },
          seed,
        }).run().totalTime;
      }
      return total / 15;
    };
    expect(timeOf('steffen-perfect')).toBeLessThan(timeOf('outside-in'));
    expect(timeOf('outside-in')).toBeLessThan(timeOf('random'));
    expect(timeOf('random')).toBeLessThan(timeOf('back-to-front'));
  });
});

describe('every control at its limits', () => {
  it.each(CONTROL_SPECS.map((s) => [s.label, s] as const))(
    '%s is sound across its whole range',
    (_label, spec) => {
      const values = [spec.min, (spec.min + spec.max) / 2, spec.max];
      for (const raw of values) {
        // Land on a real step, the way the input element would.
        const v = Math.round(raw / spec.step) * spec.step;
        const scenario = structuredClone(DEFAULT_SCENARIO);
        spec.set(scenario, v);
        assertSound(scenario, `${spec.label}=${v}`);
      }
    },
  );

  it('handles every gate release setting', () => {
    for (let v = GATE_RANGES.releaseGroups.min; v <= GATE_RANGES.releaseGroups.max; v++) {
      const groups = v >= 13 ? null : v;
      assertSound(
        {
          ...DEFAULT_SCENARIO,
          boarding: { ...DEFAULT_SCENARIO.boarding, releaseGroups: groups },
        },
        `groups=${groups}`,
      );
    }
  });

  it('handles every block count on the strategies that use blocks', () => {
    for (const strategy of ['back-to-front', 'front-to-back', 'reverse-pyramid'] as const) {
      for (let b = GATE_RANGES.blocks.min; b <= GATE_RANGES.blocks.max; b++) {
        assertSound(
          { ...DEFAULT_SCENARIO, boarding: { ...DEFAULT_SCENARIO.boarding, strategy, blocks: b } },
          `${strategy}/blocks=${b}`,
        );
      }
    }
  });

  it('handles every toggle combination', () => {
    for (const preboard of [false, true]) {
      for (const families of [false, true]) {
        for (const gateCheck of [false, true]) {
          assertSound(
            {
              ...DEFAULT_SCENARIO,
              boarding: {
                ...DEFAULT_SCENARIO.boarding,
                preboardAssistance: preboard,
                familiesBoardTogether: families,
              },
              params: { ...DEFAULT_SCENARIO.params, gateCheckWhenFull: gateCheck },
            },
            `preboard=${preboard}/families=${families}/gateCheck=${gateCheck}`,
          );
        }
      }
    }
  });

  it.each(AIRCRAFT_TYPES.map((t) => [t.id, t.id] as const))(
    '%s flies every strategy',
    (_id, typeId) => {
      for (const strategy of ALL_STRATEGIES) {
        assertSound(
          {
            ...DEFAULT_SCENARIO,
            cabin: { ...DEFAULT_SCENARIO.cabin, typeId },
            boarding: { ...DEFAULT_SCENARIO.boarding, strategy },
          },
          `${typeId}/${strategy}`,
        );
      }
    },
  );
});

describe('the corners of the space', () => {
  const corner = (name: string, over: Partial<Scenario>) => [name, over] as const;

  it.each([
    corner('smallest cabin, emptiest flight', {
      cabin: { typeId: 'a320', rows: 8, firstClassRows: 0, binSlotsPerRow: 3 },
      population: { ...DEFAULT_SCENARIO.population, loadFactor: 0.4, meanBags: 0 },
    }),
    corner('largest cabin, fullest flight, most bags', {
      cabin: { typeId: 'a320', rows: 50, firstClassRows: 8, binSlotsPerRow: 3 },
      population: {
        loadFactor: 1,
        meanBags: 2.5,
        partyFraction: 0.9,
        childFraction: 0.8,
        assistanceFraction: 0.15,
        speedSpread: 0.5,
      },
    }),
    corner('all first class but one row', {
      cabin: { typeId: 'a320', rows: 9, firstClassRows: 8, binSlotsPerRow: 12 },
    }),
    corner('nobody in a party, nobody needing help', {
      population: {
        ...DEFAULT_SCENARIO.population,
        partyFraction: 0,
        childFraction: 0,
        assistanceFraction: 0,
      },
    }),
    corner('everyone in a party, everyone a child', {
      population: { ...DEFAULT_SCENARIO.population, partyFraction: 0.9, childFraction: 0.8 },
    }),
    corner('bins far too small for the bags carried', {
      cabin: { typeId: 'a320', rows: 30, firstClassRows: 0, binSlotsPerRow: 3 },
      population: { ...DEFAULT_SCENARIO.population, loadFactor: 1, meanBags: 2.5 },
      params: { ...DEFAULT_SCENARIO.params, gateCheckWhenFull: false },
    }),
    corner('no pace variation at all', {
      population: { ...DEFAULT_SCENARIO.population, speedSpread: 0 },
    }),
  ])('%s', (name, over) => {
    for (const strategy of ALL_STRATEGIES) {
      assertSound({ ...DEFAULT_SCENARIO, ...over, boarding: { ...DEFAULT_SCENARIO.boarding, strategy } }, `${name}/${strategy}`);
    }
  });

  it('clamps first class to leave at least one economy row', () => {
    // The rows slider drags firstClassRows down with it; the cabin builder must
    // not be handed a configuration with no economy section.
    const spec = CONTROL_SPECS.find((s) => s.label === 'Rows')!;
    const scenario = structuredClone(DEFAULT_SCENARIO);
    scenario.cabin.firstClassRows = 8;
    spec.set(scenario, 8);
    expect(scenario.cabin.firstClassRows).toBeLessThan(scenario.cabin.rows);
    assertSound(scenario, 'clamped first class');
  });

  it('gives the same answer twice for every preset', () => {
    for (const preset of PRESETS) {
      const a = createSimulation(preset.scenario).run();
      const b = createSimulation(preset.scenario).run();
      expect(a.totalTime, preset.id).toBe(b.totalTime);
      expect(a.gateChecked, preset.id).toBe(b.gateChecked);
      expect(a.totalBlockedSeconds, preset.id).toBe(b.totalBlockedSeconds);
    }
  });
});
