import { DEFAULT_SCENARIO, type Scenario } from './run.ts';

/**
 * Starting points worth exploring, rather than leaving the user to discover the
 * interesting corners of a nine-slider parameter space by accident.
 *
 * The first one reproduces the experiment the engine is calibrated against, so
 * the published times can be checked in the app itself.
 */

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  scenario: Scenario;
}

function preset(over: {
  cabin?: Partial<Scenario['cabin']>;
  population?: Partial<Scenario['population']>;
  boarding?: Partial<Scenario['boarding']>;
}): Scenario {
  const base = structuredClone(DEFAULT_SCENARIO);
  return {
    ...base,
    cabin: { ...base.cabin, ...over.cabin },
    population: { ...base.population, ...over.population },
    boarding: { ...base.boarding, ...over.boarding },
  };
}

export const PRESETS: Preset[] = [
  {
    id: 'a320',
    name: 'Full A320',
    blurb: '30 rows, 95% full, families together, assistance preboarded. The everyday case.',
    scenario: preset({}),
  },
  {
    id: 'steffen-2011',
    name: 'Steffen 2011 experiment',
    blurb:
      'The mock 757 the engine is calibrated against: 12 rows, 72 passengers, numbered tickets so order is enforced exactly. Compare against the measured times in the research panel.',
    scenario: preset({
      cabin: { rows: 12, firstClassRows: 0, binSlotsPerRow: 7 },
      population: {
        loadFactor: 1,
        meanBags: 1.2,
        partyFraction: 0.08,
        assistanceFraction: 0,
        childFraction: 0.5,
      speedSpread: 0.25,
      },
      boarding: {
        strategy: 'steffen-perfect',
        releaseGroups: null,
        preboardAssistance: false,
        familiesBoardTogether: true,
      },
    }),
  },
  {
    id: 'holiday',
    name: 'Holiday getaway',
    blurb:
      'Packed, bag-heavy and full of families. Overhead space runs out, so late boarders hunt for bins — the case where every strategy degrades.',
    scenario: preset({
      cabin: { rows: 32, firstClassRows: 0, binSlotsPerRow: 5 },
      population: {
        loadFactor: 1,
        meanBags: 1.8,
        partyFraction: 0.7,
        assistanceFraction: 0.03,
        childFraction: 0.45,
      speedSpread: 0.25,
      },
      boarding: { strategy: 'back-to-front', releaseGroups: 4, familiesBoardTogether: true },
    }),
  },
  {
    id: 'business',
    name: 'Business shuttle',
    blurb:
      'Light loads, few bags, hardly any groups — the conditions where boarding order barely matters and airlines can board by status without paying for it.',
    scenario: preset({
      cabin: { rows: 26, firstClassRows: 5, binSlotsPerRow: 9 },
      population: {
        loadFactor: 0.75,
        meanBags: 0.7,
        partyFraction: 0.08,
        assistanceFraction: 0.01,
        childFraction: 0.05,
      speedSpread: 0.25,
      },
      boarding: { strategy: 'premium-first', releaseGroups: 2 },
    }),
  },
  {
    id: 'budget',
    name: 'Budget carrier',
    blurb:
      'No first class, everyone brought a roll-aboard to dodge the checked-bag fee, and boarding is a free-for-all with one group.',
    scenario: preset({
      cabin: { rows: 33, firstClassRows: 0, binSlotsPerRow: 5 },
      population: {
        loadFactor: 0.98,
        meanBags: 1.9,
        partyFraction: 0.4,
        assistanceFraction: 0.02,
        childFraction: 0.3,
      speedSpread: 0.25,
      },
      boarding: {
        strategy: 'random',
        releaseGroups: 1,
        preboardAssistance: true,
        familiesBoardTogether: true,
      },
    }),
  },
];
