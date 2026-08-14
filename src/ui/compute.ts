import { compareStrategies, findAxis, sweepParameter } from '../engine/batch.ts';
import type { StrategyResult, SweepParam, SweepResult } from '../engine/batch.ts';
import { runCalibration, type CalibrationRow } from '../engine/calibration.ts';
import { analyzeScenario, type AnalysisResult } from '../engine/insights.ts';
import { createPin, type Pin, type PinRequest } from '../engine/bench.ts';
import { optimizePolicy } from '../engine/optimize.ts';
import type {
  OptimizeOptions,
  OptimizeProgress,
  OptimizeResult,
} from '../engine/optimize.ts';
import type { Scenario } from '../engine/run.ts';
import type { ComputeRequest, ComputeResponse } from '../engine/compute-protocol.ts';

/**
 * Promise-based handle on the compute worker, with a synchronous fallback.
 *
 * If a worker cannot be constructed — an environment without module workers, or
 * a page opened straight off the filesystem — the same functions run inline.
 * The UI still works; it just blocks while it thinks.
 */
/**
 * A request minus its id. `Omit` must be distributed across the union by hand —
 * applied directly it would collapse to only the keys every variant shares.
 */
type PendingRequest = ComputeRequest extends infer R
  ? R extends ComputeRequest
    ? Omit<R, 'id'>
    : never
  : never;

export interface Compute {
  readonly threaded: boolean;
  compare(scenario: Scenario, trials: number, naturalGroups: boolean): Promise<StrategyResult[]>;
  sweep(scenario: Scenario, trials: number, param: SweepParam): Promise<SweepResult>;
  calibrate(trials: number): Promise<CalibrationRow[]>;
  analyze(scenario: Scenario, trials: number): Promise<AnalysisResult>;
  pin(request: PinRequest): Promise<Pin>;
  optimize(
    scenario: Scenario,
    options: OptimizeOptions,
    onProgress?: (p: OptimizeProgress) => void,
  ): Promise<OptimizeResult>;
}

export function createCompute(): Compute {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }

  if (!worker) return inlineCompute();

  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: never) => void;
      reject: (reason: Error) => void;
      onProgress?: (p: OptimizeProgress) => void;
    }
  >();

  worker.addEventListener('message', (event: MessageEvent<ComputeResponse>) => {
    const response = event.data;
    const entry = pending.get(response.id);
    if (!entry) return;
    // Progress messages are interim; the request stays open until a terminal one.
    if (response.kind === 'progress') {
      entry.onProgress?.(response.progress);
      return;
    }
    pending.delete(response.id);
    if (response.kind === 'error') entry.reject(new Error(response.message));
    else entry.resolve(response.result as never);
  });

  // A worker that dies takes every outstanding request with it.
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'compute worker failed');
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  });

  const send = <T>(
    request: PendingRequest,
    onProgress?: (p: OptimizeProgress) => void,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        ...(onProgress ? { onProgress } : {}),
      });
      worker.postMessage({ ...request, id } as ComputeRequest);
    });

  return {
    threaded: true,
    compare: (scenario, trials, naturalGroups) =>
      send({ kind: 'compare', scenario, trials, naturalGroups }),
    sweep: (scenario, trials, param) => send({ kind: 'sweep', scenario, trials, param }),
    calibrate: (trials) => send({ kind: 'calibrate', trials }),
    analyze: (scenario, trials) => send({ kind: 'analyze', scenario, trials }),
    pin: (request) => send({ kind: 'pin', request }),
    optimize: (scenario, options, onProgress) =>
      send({ kind: 'optimize', scenario, options }, onProgress),
  };
}

function inlineCompute(): Compute {
  return {
    threaded: false,
    compare: async (scenario, trials, naturalGroups) =>
      compareStrategies(scenario, trials, naturalGroups),
    sweep: async (scenario, trials, param) =>
      sweepParameter(scenario, findAxis(param), trials),
    calibrate: async (trials) => runCalibration(trials),
    analyze: async (scenario, trials) => analyzeScenario(scenario, trials),
    pin: async (request) => createPin(request),
    optimize: async (scenario, options, onProgress) =>
      optimizePolicy(scenario, options, onProgress),
  };
}
