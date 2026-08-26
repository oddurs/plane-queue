import { buildCabin } from './cabin.ts';
import { generatePopulation } from './passengers.ts';
import { orderWithGroups } from './strategies.ts';
import { buildQueue } from './groups.ts';
import { Simulation, DEFAULT_PARAMS } from './sim.ts';
import { Rng } from './rng.ts';
import type {
  BoardingConfig,
  CabinConfig,
  PopulationConfig,
  SimParams,
} from './types.ts';

/** Everything needed to reproduce one boarding run. */
export interface Scenario {
  cabin: CabinConfig;
  population: PopulationConfig;
  boarding: BoardingConfig;
  params: SimParams;
  seed: number;
}

export const DEFAULT_SCENARIO: Scenario = {
  cabin: { typeId: 'a320', rows: 30, firstClassRows: 3, binSlotsPerRow: 8 },
  population: {
    loadFactor: 0.95,
    meanBags: 1.0,
    partyFraction: 0.35,
    assistanceFraction: 0.02,
    childFraction: 0.35,
    speedSpread: 0.25,
  },
  boarding: {
    strategy: 'back-to-front',
    blocks: 4,
    releaseGroups: 4,
    preboardAssistance: true,
    familiesBoardTogether: true,
  },
  params: DEFAULT_PARAMS,
  seed: 1,
};

/**
 * Builds a ready-to-step simulation from a scenario.
 *
 * The population is generated from its own RNG stream so that switching
 * strategy compares like with like: the same people, the same bags, the same
 * seats — only the queue order changes.
 */
export function createSimulation(scenario: Scenario): Simulation {
  const cabin = buildCabin(scenario.cabin);

  const populationRng = new Rng(scenario.seed);
  const passengers = generatePopulation(cabin, scenario.population, populationRng);

  const orderRng = new Rng(scenario.seed ^ 0x9e3779b9);
  const ordered = orderWithGroups(
    scenario.boarding.strategy,
    cabin,
    passengers,
    {
      blocks: scenario.boarding.blocks,
      ...(scenario.boarding.customWeights
        ? { weights: scenario.boarding.customWeights }
        : {}),
    },
    orderRng,
  );
  const queue = buildQueue(ordered, scenario.boarding, orderRng);

  const simRng = new Rng(scenario.seed ^ 0x85ebca6b);
  return new Simulation(cabin, queue, scenario.params, simRng);
}

export function runScenario(scenario: Scenario) {
  return createSimulation(scenario).run();
}
