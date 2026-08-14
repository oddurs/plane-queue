import { describe, expect, it } from 'vitest';
import { analyzeScenario, type Insight } from '../src/engine/insights.ts';
import { DEFAULT_SCENARIO, type Scenario } from '../src/engine/run.ts';
import { PRESETS } from '../src/engine/presets.ts';

const find = (insights: Insight[], id: string): Insight | undefined =>
  insights.find((i) => i.id === id);

describe('scenario analysis', () => {
  const result = analyzeScenario(DEFAULT_SCENARIO, 10);

  it('always opens with a verdict on strategy choice', () => {
    expect(result.insights[0]?.kind).toBe('verdict');
    expect(result.baseline).toBeGreaterThan(0);
    expect(result.trials).toBe(10);
  });

  it('names the fastest strategy and whether it is already selected', () => {
    expect(result.bestStrategy).not.toBeNull();
    expect(result.alreadyBest).toBe(result.bestStrategy === DEFAULT_SCENARIO.boarding.strategy);
  });

  it('ranks levers by the size of their effect', () => {
    const levers = result.insights.filter((i) => i.kind === 'lever');
    expect(levers.length).toBeGreaterThan(1);
    for (let i = 1; i < levers.length; i++) {
      const prev = Math.abs(levers[i - 1]!.savingSeconds ?? 0);
      const cur = Math.abs(levers[i]!.savingSeconds ?? 0);
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });

  it('puts verdicts and observations ahead of levers', () => {
    const kinds = result.insights.map((i) => i.kind);
    const lastNonLever = kinds.reduce((acc, k, i) => (k !== 'lever' ? i : acc), -1);
    const firstLever = kinds.indexOf('lever');
    if (firstLever >= 0 && lastNonLever >= 0) expect(firstLever).toBeGreaterThan(lastNonLever);
  });

  it('reports carry-on volume as a real lever while the bins can still take them', () => {
    // 30 rows x 8 slots is 240 bag spaces for 165 passengers, so at 1.2 bags
    // each the cabin still swallows everything and volume genuinely costs time.
    const withinCapacity: Scenario = {
      ...DEFAULT_SCENARIO,
      population: { ...DEFAULT_SCENARIO.population, meanBags: 1.2 },
    };
    const bags = find(analyzeScenario(withinCapacity, 12).insights, 'fewer-bags');
    expect(bags).toBeDefined();
    expect(bags!.savingSeconds).toBeGreaterThan(0);
    expect(bags!.title).toContain('save');
  });

  it('stops crediting fewer bags once the bins are the binding constraint', () => {
    // Above capacity the gate is already taking the excess, so asking people to
    // carry less removes bags that were never going into the cabin anyway. The
    // honest report is that the lever has stopped working, not a saving.
    const overCapacity: Scenario = {
      ...DEFAULT_SCENARIO,
      population: { ...DEFAULT_SCENARIO.population, meanBags: 2.4 },
    };
    const bags = find(analyzeScenario(overCapacity, 12).insights, 'fewer-bags');
    expect(bags).toBeDefined();
    const withinCapacity = find(
      analyzeScenario(
        { ...DEFAULT_SCENARIO, population: { ...DEFAULT_SCENARIO.population, meanBags: 1.2 } },
        12,
      ).insights,
      'fewer-bags',
    );
    expect(bags!.savingSeconds!).toBeLessThan(withinCapacity!.savingSeconds!);
  });

  it('offers no bag lever when nobody is carrying anything', () => {
    const empty: Scenario = {
      ...DEFAULT_SCENARIO,
      population: { ...DEFAULT_SCENARIO.population, meanBags: 0 },
    };
    expect(find(analyzeScenario(empty, 8).insights, 'fewer-bags')).toBeUndefined();
  });

  it('skips levers that are already pulled', () => {
    const strict: Scenario = {
      ...DEFAULT_SCENARIO,
      boarding: {
        ...DEFAULT_SCENARIO.boarding,
        releaseGroups: null,
        preboardAssistance: false,
        familiesBoardTogether: false,
      },
    };
    const insights = analyzeScenario(strict, 8).insights;
    expect(find(insights, 'strict-order')).toBeUndefined();
    expect(find(insights, 'split-families')).toBeUndefined();
    expect(find(insights, 'no-preboard')).toBeUndefined();
  });

  it('marks an effect inside the noise band as inconclusive rather than a win', () => {
    // A near-empty cabin with no luggage leaves almost nothing for any lever to
    // do, so the honest answer is "no measurable difference".
    const quiet: Scenario = {
      ...DEFAULT_SCENARIO,
      population: {
        ...DEFAULT_SCENARIO.population,
        loadFactor: 0.45,
        meanBags: 0.1,
        partyFraction: 0,
        assistanceFraction: 0,
      },
    };
    const levers = analyzeScenario(quiet, 12).insights.filter((i) => i.kind === 'lever');
    const inconclusive = levers.filter((i) => i.savingSeconds === 0);
    expect(inconclusive.length).toBeGreaterThan(0);
    for (const i of inconclusive) expect(i.detail).toContain('noise band');
  });

  it('marks accessibility and family levers as advisory, never as recommendations', () => {
    const insights = analyzeScenario(
      {
        ...DEFAULT_SCENARIO,
        population: { ...DEFAULT_SCENARIO.population, assistanceFraction: 0.05 },
      },
      8,
    ).insights;

    for (const id of ['no-preboard', 'split-families']) {
      const lever = find(insights, id);
      expect(lever, id).toBeDefined();
      expect(lever!.advisory, id).toBe(true);
    }
    // Operational levers are ordinary recommendations.
    expect(find(insights, 'fewer-bags')?.advisory).toBeUndefined();
    expect(find(insights, 'more-bins')?.advisory).toBeUndefined();
  });

  it('flags bin pressure only when overhead space is actually short', () => {
    const tight = analyzeScenario(
      { ...DEFAULT_SCENARIO, cabin: { ...DEFAULT_SCENARIO.cabin, binSlotsPerRow: 3 } },
      8,
    );
    const roomy = analyzeScenario(
      { ...DEFAULT_SCENARIO, cabin: { ...DEFAULT_SCENARIO.cabin, binSlotsPerRow: 12 } },
      8,
    );
    expect(find(tight.insights, 'bin-pressure')).toBeDefined();
    expect(find(roomy.insights, 'bin-pressure')).toBeUndefined();
  });

  it('produces usable findings for every preset', () => {
    for (const preset of PRESETS) {
      const analysis = analyzeScenario(preset.scenario, 6);
      expect(analysis.insights.length, preset.id).toBeGreaterThan(1);
      for (const insight of analysis.insights) {
        expect(insight.title.length, `${preset.id}/${insight.id}`).toBeGreaterThan(0);
        expect(insight.detail.length, `${preset.id}/${insight.id}`).toBeGreaterThan(0);
        // Titles are sentences shown to a human, not slugs.
        expect(insight.title, `${preset.id}/${insight.id}`).not.toMatch(/undefined|NaN/);
        expect(insight.detail, `${preset.id}/${insight.id}`).not.toMatch(/undefined|NaN/);
      }
    }
  });
});
