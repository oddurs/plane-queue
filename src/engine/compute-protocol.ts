import type { StrategyResult, SweepParam, SweepResult } from './batch.ts';
import type { CalibrationRow } from './calibration.ts';
import type { AnalysisResult } from './insights.ts';
import type { Pin, PinRequest } from './bench.ts';
import type { OptimizeOptions, OptimizeProgress, OptimizeResult } from './optimize.ts';
import type { Scenario } from './run.ts';

/** Message shapes shared by the main thread and the compute worker. */

export type ComputeRequest =
  | { id: number; kind: 'compare'; scenario: Scenario; trials: number; naturalGroups: boolean }
  | { id: number; kind: 'sweep'; scenario: Scenario; trials: number; param: SweepParam }
  | { id: number; kind: 'calibrate'; trials: number }
  | { id: number; kind: 'optimize'; scenario: Scenario; options: OptimizeOptions }
  | { id: number; kind: 'analyze'; scenario: Scenario; trials: number }
  | { id: number; kind: 'pin'; request: PinRequest };

export type ComputeResponse =
  | { id: number; kind: 'compare'; result: StrategyResult[] }
  | { id: number; kind: 'sweep'; result: SweepResult }
  | { id: number; kind: 'calibrate'; result: CalibrationRow[] }
  | { id: number; kind: 'optimize'; result: OptimizeResult }
  | { id: number; kind: 'analyze'; result: AnalysisResult }
  | { id: number; kind: 'pin'; result: Pin }
  /** Interim update; the request stays open until its terminal response. */
  | { id: number; kind: 'progress'; progress: OptimizeProgress }
  | { id: number; kind: 'error'; message: string };
