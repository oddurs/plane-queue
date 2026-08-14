import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/engine/presets.ts';
import { createSimulation, runScenario } from '../src/engine/run.ts';
import { compareStrategies } from '../src/engine/batch.ts';

describe('presets', () => {
  it('all board successfully and produce plausible times', () => {
    for (const preset of PRESETS) {
      const sim = createSimulation(preset.scenario);
      const metrics = sim.run();
      expect(sim.done, preset.id).toBe(true);
      // Anything outside 1-40 minutes means the scenario is misconfigured.
      expect(metrics.totalTime, preset.id).toBeGreaterThan(60);
      expect(metrics.totalTime, preset.id).toBeLessThan(2400);
    }
  });

  it('keeps first-class rows within the cabin', () => {
    for (const preset of PRESETS) {
      expect(preset.scenario.cabin.firstClassRows, preset.id).toBeLessThan(
        preset.scenario.cabin.rows,
      );
    }
  });

  it('reproduces the published ordering on the Steffen 2011 preset', () => {
    const preset = PRESETS.find((p) => p.id === 'steffen-2011');
    expect(preset).toBeDefined();

    const steffen = runScenario({
      ...preset!.scenario,
      boarding: { ...preset!.scenario.boarding, strategy: 'steffen-perfect' },
    });
    const backToFront = runScenario({
      ...preset!.scenario,
      boarding: {
        ...preset!.scenario.boarding,
        strategy: 'back-to-front',
        blocks: 12,
      },
    });
    expect(steffen.totalTime).toBeLessThan(backToFront.totalTime);
  });
});

describe('batch comparison', () => {
  const scenario = PRESETS[0]!.scenario;

  it('ranks every strategy and returns them fastest first', () => {
    const results = compareStrategies(scenario, 5, true);
    expect(results).toHaveLength(8);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.median).toBeGreaterThanOrEqual(results[i - 1]!.median);
    }
  });

  it('returns a usable curve and sane quantiles for each strategy', () => {
    for (const r of compareStrategies(scenario, 5, true)) {
      expect(r.p25, r.name).toBeLessThanOrEqual(r.median);
      expect(r.median, r.name).toBeLessThanOrEqual(r.p75);
      expect(r.min, r.name).toBeLessThanOrEqual(r.max);
      expect(r.curve.length, r.name).toBeGreaterThan(1);
      expect(r.curve.at(-1)!.seated, r.name).toBeGreaterThan(0);
      expect(r.blockedSeconds, r.name).toBeGreaterThan(0);
    }
  });

  it('puts Steffen ahead of front-to-back under realistic gate groups', () => {
    const results = compareStrategies(scenario, 12, true);
    const rank = (id: string): number => results.findIndex((r) => r.strategy === id);
    expect(rank('steffen-perfect')).toBeLessThan(rank('front-to-back'));
    expect(rank('steffen-perfect')).toBeLessThan(rank('back-to-front'));
  });
});
