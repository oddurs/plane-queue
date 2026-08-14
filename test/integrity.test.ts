import { describe, expect, it } from 'vitest';
import { createSimulation, runScenario, DEFAULT_SCENARIO, type Scenario } from '../src/engine/run.ts';
import { compareStrategies } from '../src/engine/batch.ts';
import { analyzeScenario } from '../src/engine/insights.ts';
import { seatLabel } from '../src/engine/cabin.ts';
import type { StrategyId } from '../src/engine/types.ts';

/**
 * Guards on the two things everything else rests on: that a reported number is
 * a real measurement, and that competing options are compared on identical
 * passengers.
 */

/** Too many people, too much luggage, too little time to finish. */
const UNFINISHABLE: Scenario = {
  ...DEFAULT_SCENARIO,
  cabin: { rows: 50, firstClassRows: 0, binSlotsPerRow: 3 },
  population: {
    loadFactor: 1,
    meanBags: 2.5,
    partyFraction: 0.8,
    assistanceFraction: 0.1,
    childFraction: 0.5,
      speedSpread: 0.25,
  },
  params: { ...DEFAULT_SCENARIO.params, maxSimSeconds: 240 },
};

describe('a truncated run is never presented as a measurement', () => {
  it('marks a run stopped by the safety cap as incomplete', () => {
    const sim = createSimulation(UNFINISHABLE);
    const metrics = sim.run();

    expect(sim.done).toBe(false);
    expect(metrics.complete).toBe(false);
    // The reported time is the cap, which is exactly why it must not be read
    // as a boarding time.
    expect(metrics.totalTime).toBeCloseTo(UNFINISHABLE.params.maxSimSeconds, 0);
  });

  it('marks an ordinary run complete', () => {
    const metrics = runScenario({ ...DEFAULT_SCENARIO, seed: 3 });
    expect(metrics.complete).toBe(true);
    expect(metrics.totalTime).toBeLessThan(DEFAULT_SCENARIO.params.maxSimSeconds);
  });

  it('counts capped trials in the strategy ranking instead of hiding them', () => {
    const results = compareStrategies(UNFINISHABLE, 2, true);
    expect(results.every((r) => r.incompleteRuns === 2)).toBe(true);

    // Without the count, this is the failure mode: every strategy pins to the
    // cap and the ranking reads as a perfect tie.
    const medians = new Set(results.map((r) => Math.round(r.median)));
    expect(medians.size).toBe(1);
  });

  it('reports no capped trials on a scenario that finishes', () => {
    const results = compareStrategies(DEFAULT_SCENARIO, 3, true);
    expect(results.every((r) => r.incompleteRuns === 0)).toBe(true);
  });

  it('refuses to draw findings from capped runs', () => {
    const analysis = analyzeScenario(UNFINISHABLE, 2);
    expect(analysis.truncated).toBe(true);
    expect(analysis.insights).toHaveLength(1);
    expect(analysis.insights[0]!.id).toBe('truncated');
    // No lever may be recommended off the back of non-measurements.
    expect(analysis.insights.some((i) => i.kind === 'lever')).toBe(false);
    expect(analysis.bestStrategy).toBeNull();
  });

  it('draws findings normally when runs complete', () => {
    const analysis = analyzeScenario(DEFAULT_SCENARIO, 4);
    expect(analysis.truncated).toBe(false);
    expect(analysis.insights.length).toBeGreaterThan(1);
  });
});

describe('the same seed always means the same passengers', () => {
  const manifest = (strategy: StrategyId, seed: number): string =>
    createSimulation({
      ...DEFAULT_SCENARIO,
      boarding: { ...DEFAULT_SCENARIO.boarding, strategy },
      seed,
    })
      .agents.map(
        (a) =>
          `${seatLabel(a.passenger.seat)}/${a.passenger.bags}/` +
          `${a.passenger.partyId}/${a.passenger.needsAssistance}`,
      )
      .sort()
      .join(',');

  it('holds across every strategy — the basis of every comparison in the app', () => {
    // If this ever fails, every "same passengers, only the order differs" claim
    // the app makes becomes false, silently.
    const reference = manifest('random', 5);
    const ids: StrategyId[] = [
      'back-to-front',
      'front-to-back',
      'outside-in',
      'reverse-pyramid',
      'steffen-perfect',
      'steffen-modified',
      'premium-first',
    ];
    for (const id of ids) expect(manifest(id, 5), id).toBe(reference);
  });

  it('holds across gate settings, which must not disturb who is aboard', () => {
    const base = manifest('outside-in', 9);
    for (const boarding of [
      { releaseGroups: null },
      { releaseGroups: 1 },
      { familiesBoardTogether: false },
      { preboardAssistance: false },
      { blocks: 12 },
    ]) {
      const seats = createSimulation({
        ...DEFAULT_SCENARIO,
        boarding: { ...DEFAULT_SCENARIO.boarding, strategy: 'outside-in', ...boarding },
        seed: 9,
      })
        .agents.map(
          (a) =>
            `${seatLabel(a.passenger.seat)}/${a.passenger.bags}/` +
            `${a.passenger.partyId}/${a.passenger.needsAssistance}`,
        )
        .sort()
        .join(',');
      expect(seats, JSON.stringify(boarding)).toBe(base);
    }
  });

  it('gives genuinely different passengers to different seeds', () => {
    expect(manifest('random', 5)).not.toBe(manifest('random', 6));
  });

  it('keeps the population stream independent of the ordering stream', () => {
    // The three streams are derived from one seed. If they were correlated,
    // adjacent seeds could reuse a stream and quietly collapse the variety that
    // Monte Carlo trials depend on.
    const manifests = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) manifests.add(manifest('random', seed));
    expect(manifests.size).toBe(40);
  });
});

describe('rendering cannot perturb the simulation', () => {
  /**
   * The smooth-animation guarantee rests on one rule: the renderer reads a
   * snapshot and never writes to it. If that ever stops being true, frame rate
   * would start influencing measured boarding times — which is exactly the
   * failure this app could least afford.
   */
  const snapshotState = (sim: ReturnType<typeof createSimulation>): string =>
    sim.agents
      .map(
        (a) =>
          `${a.passenger.id}:${a.state}:${a.pos}:${a.fromPos}:` +
          `${a.timer.toFixed(6)}:${a.stepDuration.toFixed(6)}:${a.blocked}:` +
          `${a.aisleTime.toFixed(6)}:${a.blockedTime.toFixed(6)}:${a.binOffset}`,
      )
      .join('|');

  it('leaves agent state untouched when a snapshot is read repeatedly', () => {
    const sim = createSimulation({ ...DEFAULT_SCENARIO, seed: 21 });
    for (let i = 0; i < 200; i++) sim.step();

    const before = snapshotState(sim);
    // What a draw does: read the snapshot, the seats and the bins, many times
    // over — as a 120Hz renderer would between two engine ticks.
    for (let frame = 0; frame < 120; frame++) {
      const snap = sim.snapshot();
      void snap.agents.map((a) => a.pos + a.timer);
      void [...sim.occupiedSeats];
      void [...sim.remainingBinSlots];
      void sim.metrics();
    }
    expect(snapshotState(sim)).toBe(before);
  });

  it('produces identical metrics no matter how often it was observed', () => {
    const run = (observe: boolean) => {
      const sim = createSimulation({ ...DEFAULT_SCENARIO, seed: 33 });
      while (sim.step()) {
        if (observe) {
          // Stand in for drawing several frames per engine tick.
          for (let f = 0; f < 8; f++) {
            sim.snapshot();
            sim.metrics();
          }
        }
      }
      return sim.metrics();
    };

    const quiet = run(false);
    const watched = run(true);
    expect(watched.totalTime).toBe(quiet.totalTime);
    expect(watched.stallEvents).toBe(quiet.stallEvents);
    expect(watched.seatInterferenceTotal).toBe(quiet.seatInterferenceTotal);
    expect(watched.totalBlockedSeconds).toBe(quiet.totalBlockedSeconds);
    expect(watched.binSearches).toBe(quiet.binSearches);
  });

  it('keeps the engine timestep fixed, so frame rate cannot change results', () => {
    // Interpolation is the only thing that may vary with frame rate. The tick
    // the calibration is fitted at must stay put.
    expect(DEFAULT_SCENARIO.params.tick).toBe(0.25);
  });
});
