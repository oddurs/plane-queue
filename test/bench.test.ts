import { describe, expect, it } from 'vitest';
import { comparePins, createPin, describeScenario, type Pin } from '../src/engine/bench.ts';
import { DEFAULT_SCENARIO, type Scenario } from '../src/engine/run.ts';

const pinOf = (scenario: Scenario, trials = 8, at = 1_700_000_000_000): Pin =>
  createPin({ scenario, trials, createdAt: at });

describe('pinning a run', () => {
  const pin = pinOf(DEFAULT_SCENARIO);

  it('samples the scenario rather than saving one boarding', () => {
    expect(pin.time.n).toBe(8);
    expect(pin.time.mean).toBeGreaterThan(0);
    // A single run has no spread; a sample does.
    expect(pin.time.sd).toBeGreaterThan(0);
  });

  it('keeps its own copy of the scenario, immune to later edits', () => {
    const scenario = structuredClone(DEFAULT_SCENARIO);
    const taken = pinOf(scenario);
    scenario.cabin.rows = 12;
    scenario.boarding.strategy = 'random';
    expect(taken.scenario.cabin.rows).toBe(DEFAULT_SCENARIO.cabin.rows);
    expect(taken.scenario.boarding.strategy).toBe(DEFAULT_SCENARIO.boarding.strategy);
  });

  it('is reproducible: the same scenario pinned twice measures the same', () => {
    const again = pinOf(DEFAULT_SCENARIO);
    expect(again.time.mean).toBe(pin.time.mean);
    expect(again.time.sd).toBe(pin.time.sd);
  });

  it('labels itself from what makes the scenario distinctive', () => {
    expect(pin.label).toContain('A320');
    expect(pin.label).toContain('Back to front');
    expect(pin.label).toMatch(/\d+ pax/);
  });

  it('accepts a user label over the generated one', () => {
    const named = createPin({
      scenario: DEFAULT_SCENARIO,
      trials: 4,
      createdAt: 1,
      label: '  Holiday baseline  ',
    });
    expect(named.label).toBe('Holiday baseline');
  });

  it('carries forward how many sampled runs hit the time cap', () => {
    const unfinishable: Scenario = {
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
    expect(pinOf(unfinishable, 3).incompleteRuns).toBe(3);
    expect(pin.incompleteRuns).toBe(0);
  });
});

describe('describeScenario', () => {
  it('names the things that distinguish one experiment from another', () => {
    const text = describeScenario({
      ...DEFAULT_SCENARIO,
      boarding: { ...DEFAULT_SCENARIO.boarding, strategy: 'steffen-perfect', releaseGroups: null },
    });
    expect(text).toContain('Steffen (perfect)');
    expect(text).toContain('strict');
  });

  it('reports the gate group count when order is not strict', () => {
    expect(
      describeScenario({
        ...DEFAULT_SCENARIO,
        boarding: { ...DEFAULT_SCENARIO.boarding, releaseGroups: 4 },
      }),
    ).toContain('4 groups');
  });

  it('distinguishes scenarios that differ only in a population knob', () => {
    // Otherwise the bench lists identical labels with different times beside
    // them, which is worse than useless.
    const base = describeScenario(DEFAULT_SCENARIO);
    const moreKids = describeScenario({
      ...DEFAULT_SCENARIO,
      population: { ...DEFAULT_SCENARIO.population, childFraction: 0, speedSpread: 0.25 },
    });
    const splitFamilies = describeScenario({
      ...DEFAULT_SCENARIO,
      boarding: { ...DEFAULT_SCENARIO.boarding, familiesBoardTogether: false },
    });
    expect(moreKids).not.toBe(base);
    expect(splitFamilies).not.toBe(base);
    expect(splitFamilies).toContain('families split');
  });
});

describe('comparing pins', () => {
  const fast: Pin = { ...pinOf(DEFAULT_SCENARIO), id: 'fast', label: 'Fast' };
  const tight = (mean: number, id: string): Pin => ({
    ...fast,
    id,
    label: id,
    time: { mean, sd: 1, n: 20 },
  });
  // sd 120 over 20 runs gives a ±76s band, which a 60s gap does not clear.
  const noisy = (mean: number, id: string): Pin => ({
    ...fast,
    id,
    label: id,
    time: { mean, sd: 120, n: 20 },
  });

  it('refuses to compare a pin with itself', () => {
    expect(comparePins(fast, fast)).toBeNull();
  });

  it('calls a gap real only when it clears the noise band', () => {
    const real = comparePins(tight(600, 'a'), tight(660, 'b'));
    expect(real?.significant).toBe(true);
    expect(real?.faster.id).toBe('a');
    expect(real?.verdict).toContain('A real difference');

    // Same 60s gap, far noisier runs.
    const unproven = comparePins(noisy(600, 'a'), noisy(660, 'b'));
    expect(unproven?.significant).toBe(false);
    expect(unproven?.verdict).toContain('No measurable difference');
  });

  it('orders faster and slower regardless of argument order', () => {
    const a = comparePins(tight(700, 'slow'), tight(600, 'quick'));
    const b = comparePins(tight(600, 'quick'), tight(700, 'slow'));
    expect(a?.faster.id).toBe('quick');
    expect(b?.faster.id).toBe('quick');
    expect(a?.gapSeconds).toBeCloseTo(b?.gapSeconds ?? 0, 10);
  });

  it('refuses the comparison outright when either side was capped', () => {
    const capped: Pin = { ...tight(500, 'capped'), incompleteRuns: 4 };
    const result = comparePins(capped, tight(700, 'ok'));
    expect(result?.verdict).toContain('Not comparable');
    // Being fastest means nothing if the run never finished.
    expect(result?.verdict).not.toContain('A real difference');
  });
});
