import { compareStrategies, findAxis, sweepParameter } from './batch.ts';
import { runCalibration } from './calibration.ts';
import { analyzeScenario } from './insights.ts';
import { createPin } from './bench.ts';
import { optimizePolicy } from './optimize.ts';
import type { ComputeRequest, ComputeResponse } from './compute-protocol.ts';

/**
 * Runs the expensive analyses off the main thread.
 *
 * Monte Carlo batches and sensitivity sweeps are thousands of boardings each,
 * which is enough to stall the animation for seconds. The engine has no DOM
 * dependencies, so it drops into a worker unchanged.
 */
self.onmessage = (event: MessageEvent<ComputeRequest>) => {
  const request = event.data;
  const respond = (response: ComputeResponse): void => {
    self.postMessage(response);
  };

  try {
    switch (request.kind) {
      case 'compare':
        respond({
          id: request.id,
          kind: 'compare',
          result: compareStrategies(request.scenario, request.trials, request.naturalGroups),
        });
        break;
      case 'sweep':
        respond({
          id: request.id,
          kind: 'sweep',
          result: sweepParameter(request.scenario, findAxis(request.param), request.trials),
        });
        break;
      case 'calibrate':
        respond({ id: request.id, kind: 'calibrate', result: runCalibration(request.trials) });
        break;
      case 'pin':
        respond({ id: request.id, kind: 'pin', result: createPin(request.request) });
        break;
      case 'analyze':
        respond({
          id: request.id,
          kind: 'analyze',
          result: analyzeScenario(request.scenario, request.trials),
        });
        break;
      case 'optimize': {
        // Progress is throttled: a search runs hundreds of iterations and the
        // chart cannot show more than a few dozen updates anyway.
        const every = Math.max(1, Math.floor(request.options.iterations / 40));
        respond({
          id: request.id,
          kind: 'optimize',
          result: optimizePolicy(request.scenario, request.options, (progress) => {
            if (progress.iteration % every === 0 || progress.iteration === progress.iterations) {
              respond({ id: request.id, kind: 'progress', progress });
            }
          }),
        });
        break;
      }
    }
  } catch (error) {
    respond({
      id: request.id,
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
