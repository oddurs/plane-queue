import './styles.css';
import { DEFAULT_SCENARIO, type Scenario } from './engine/run.ts';
import { findAxis, SWEEP_AXES, type SweepParam } from './engine/batch.ts';
import { createCompute } from './ui/compute.ts';
import { PRESETS } from './engine/presets.ts';
import { naturalGroups, pickOpponent, STRATEGIES, strategyName } from './engine/strategies.ts';
import type { AnalysisResult } from './engine/insights.ts';
import type { StrategyId } from './engine/types.ts';
import { assistedCount, buildControls } from './ui/controls.ts';
import {
  boardingCurve,
  comparisonChart,
  convergenceChart,
  equityBands,
  formatDuration,
  sweepChart,
  waitByRowChart,
  type CurveSeries,
} from './ui/chart.ts';
import { computeEquity, describeEquity } from './engine/equity.ts';
import { DEFAULT_OPTIMIZE_OPTIONS, type OptimizeResult } from './engine/optimize.ts';
import { POLICY_KEYS } from './engine/policy.ts';
import { heatmapSvg } from './render/heatmap.ts';
import { STATE_COLORS } from './render/cabin-canvas.ts';
import { buildResearch } from './ui/research.ts';
import { Lane } from './ui/lane.ts';
import { createTabs } from './ui/tabs.ts';
import { loadPins, renderBench, savePins } from './ui/bench.ts';
import {
  budgetFor,
  PRECISION_HINT,
  PRECISION_LABELS,
  type Precision,
} from './ui/precision.ts';
import type { Pin } from './engine/bench.ts';

/**
 * App shell: owns the scenario, drives the animation clock for one or two
 * lanes, and keeps the canvases, readouts and charts in sync.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const LANE_A_COLOR = '#4da3ff';
const LANE_B_COLOR = '#ff5c1a';

// Batches and sweeps run off-thread so the animation keeps going while they do.
const compute = createCompute();

// Structured-clone the default so the UI can mutate freely.
let scenario: Scenario = structuredClone(DEFAULT_SCENARIO);

let lanes: Lane[] = [];
let racing = false;
let opponent: StrategyId = 'back-to-front';
let playing = false;
let speed = 12;
let lastFrame = 0;
/** Simulated seconds still owed to the engine from the last animation frame. */
let carry = 0;
/** Wall-clock ms of the last readout repaint, which is throttled. */
let lastStatsPaint = 0;
/** Charts refresh far more lazily than the readout; rebuilding them flickers. */
let lastChartPaint = 0;

// ---- lanes -----------------------------------------------------------------

function rebuildLanes(): void {
  const host = $('lanes');
  const wanted = racing ? 2 : 1;

  // Reuse existing lanes so the canvases (and their contexts) survive a restart.
  if (lanes.length !== wanted) {
    host.replaceChildren();
    lanes = [];
    for (let i = 0; i < wanted; i++) {
      const lane = new Lane(
        scenario,
        i === 0 ? scenario.boarding.strategy : opponent,
        i === 0 ? LANE_A_COLOR : LANE_B_COLOR,
        racing,
      );
      lanes.push(lane);
      host.append(lane.root);
    }
  } else {
    lanes.forEach((lane, i) =>
      lane.rebuild(scenario, i === 0 ? scenario.boarding.strategy : opponent),
    );
  }

  host.classList.toggle('racing', racing);
  carry = 0;
  lanes.forEach((l) => l.resize());
  $('verdict').hidden = true;
  draw(true);
}

function draw(force = false): void {
  for (const lane of lanes) lane.draw();

  // Repainting seven stat tiles and an SVG on every frame is wasted work; a few
  // times a second is more than enough to read.
  const now = performance.now();
  if (!force && now - lastStatsPaint < 120) return;
  lastStatsPaint = now;

  for (const lane of lanes) lane.updateStats();
  paintVerdict();

  // Charts are rebuilt wholesale from an SVG string, so repainting them at the
  // readout's cadence visibly flickers. They also change slowly — a cumulative
  // curve and a heatmap that gains one column every ten simulated seconds — so
  // a much lazier refresh loses nothing.
  if (!force && now - lastChartPaint < 700) return;
  lastChartPaint = now;

  // Painting into a hidden view would bake in the fallback width, so leave the
  // last good render alone until the view is measurable again.
  if ($('curve').clientWidth > 0) {
    paintCurve();
    paintHeatmaps();
    paintEquity();
  }
}

/**
 * The distribution of imposed delay for the lane on screen.
 *
 * Only the first lane: in a race the two cabins carry different strategies, and
 * two distributions side by side invites reading them as one.
 */
function paintEquity(): void {
  const lane = lanes[0];
  if (!lane) return;
  const metrics = lane.metrics();
  const equity = computeEquity(metrics.waits, lane.cabin.config.rows);
  const host = $('equity');
  host.innerHTML = waitByRowChart(equity, chartWidth(host));
  $('equity-bands').innerHTML = equityBands(equity);
  $('equity-note').textContent =
    metrics.waits.length === 0
      ? 'Nobody has boarded yet.'
      : `Seconds each passenger spent standing still because of somebody else — the part a strategy actually allocates, as against walking distance, which is fixed by where you sit. ${describeEquity(equity)}`;
}

function paintHeatmaps(): void {
  const host = $('heatmap');
  const width = Math.max(280, Math.round(host.clientWidth / lanes.length) - 12);
  host.innerHTML = lanes
    .map((lane) => {
      const name = strategyName(lane.strategy);
      const title =
        lanes.length > 1
          ? `<div class="heatmap-title" style="color:${lane.color}">${name}</div>`
          : '';
      return `<figure class="heatmap">${title}${heatmapSvg(lane.metrics().congestion, width)}</figure>`;
    })
    .join('');
}

/**
 * Charts are drawn with a viewBox matching their rendered pixel width, so text
 * and stroke weights stay at their intended size instead of being scaled up
 * along with the box.
 */
function chartWidth(host: HTMLElement): number {
  return Math.max(320, Math.round(host.clientWidth) || 520);
}

function paintCurve(): void {
  const first = lanes[0];
  if (!first) return;
  const series: CurveSeries[] = lanes.map((lane) => ({
    label: strategyName(lane.strategy),
    color: lane.color,
    points: lane.metrics().curve,
  }));
  const host = $('curve');
  host.innerHTML = boardingCurve(series, first.sim.snapshot().total, chartWidth(host));
}

function paintVerdict(): void {
  const verdict = $('verdict');
  const [a, b] = lanes;
  if (!racing || !a || !b || !a.done || !b.done) {
    verdict.hidden = true;
    return;
  }

  const winner = a.finishTime! <= b.finishTime! ? a : b;
  const loser = winner === a ? b : a;
  const gap = loser.finishTime! - winner.finishTime!;
  const name = (l: Lane): string => strategyName(l.strategy);

  verdict.hidden = false;

  // One race is a sample of one. Every other surface in this app tests a
  // difference against run-to-run noise before calling it a result, and the
  // most prominent claim on the page should not be the exception — so it says
  // what it is and points at the panel that can settle it.
  const caveat =
    ' <span class="verdict-caveat">Single race — see COMPARE for whether it repeats.</span>';

  verdict.innerHTML =
    gap < 1
      ? `<strong>Dead heat</strong> — both finished at ${formatDuration(winner.finishTime!)}.${caveat}`
      : `<strong style="color:${winner.color}">${name(winner)}</strong> finished ` +
        `<strong>${formatDuration(gap)}</strong> ahead — ${formatDuration(winner.finishTime!)} vs ` +
        `${formatDuration(loser.finishTime!)} boarding the same passengers ` +
        `(${(loser.finishTime! / winner.finishTime!).toFixed(2)}×).${caveat}`;
}

function stepAll(): boolean {
  let anyAlive = false;
  for (const lane of lanes) if (lane.step()) anyAlive = true;
  return anyAlive;
}

const allDone = (): boolean => lanes.every((l) => l.done);

// ---- clock -----------------------------------------------------------------

function tick(now: number): void {
  requestAnimationFrame(tick);
  if (!playing) {
    lastFrame = now;
    return;
  }

  const elapsed = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  // Convert wall-clock into whole simulation ticks, keeping the remainder so
  // playback speed stays accurate rather than drifting with the frame rate.
  carry += elapsed * speed;
  const steps = Math.floor(carry / scenario.params.tick);
  carry -= steps * scenario.params.tick;

  for (let i = 0; i < Math.min(steps, 2000); i++) {
    if (!stepAll()) break;
  }
  if (allDone()) setPlaying(false);

  draw();
}

/**
 * Applies a scenario change without interrupting play. Fiddling with a control
 * is the main way anyone uses this, so it restarts the boarding and carries on
 * rather than dumping you at a paused first frame.
 */
function restart(): void {
  const wasPlaying = playing;
  // Before the lanes are built: a strategy change can collide with the
  // opponent, and this is what moves it out of the way.
  paintOpponentPicker();
  rebuildLanes();
  setPlaying(wasPlaying);
}

function setPlaying(next: boolean): void {
  // Pressing play on a finished run restarts it rather than doing nothing.
  if (next && allDone()) rebuildLanes();
  playing = next;
  $<HTMLButtonElement>('play').textContent = next ? 'Pause' : allDone() ? 'Replay' : 'Play';
  if (!next) draw(true);
}

// ---- controls --------------------------------------------------------------

/**
 * Which controls the panel should currently be showing.
 *
 * Only a change here needs new DOM; everything else is a value the existing
 * controls can be synced to. Rebuilding on every change destroyed the element
 * under the pointer on the first `input` event of a drag, which left every
 * slider keyboard-only.
 */
function controlShape(s: Scenario): string {
  return [
    s.boarding.strategy,
    s.cabin.typeId ?? 'a320',
    s.population.partyFraction > 0,
    s.population.assistanceFraction > 0,
    // Turning the aisle-chair share up brings a control with it, so the shape
    // has to notice — a panel that only syncs values would never draw it.
    assistedCount(s, 'aisle-chair') > 0,
  ].join('|');
}

let syncControls: (() => void) | null = null;
/** A rebuild asked for mid-gesture, deferred so it cannot interrupt the drag. */
let pendingRebuild = false;

function refreshControls(): void {
  syncControls = buildControls($('controls'), scenario, (mutate) => {
    const before = controlShape(scenario);
    mutate(scenario);
    restart();
    if (controlShape(scenario) === before) {
      syncControls?.();
    } else if (dragging) {
      pendingRebuild = true;
    } else {
      refreshControls();
    }
    paintNote();
    paintMasthead();
    // Every panel's numbers were computed for the old scenario.
    invalidateAnalyses();
    refreshActiveView();
  });
}

/**
 * A pointer held down on a control is a gesture in progress. Replacing the DOM
 * under it would end the gesture, so structural changes wait for the release.
 */
let dragging = false;
function watchGestures(): void {
  const host = $('controls');
  host.addEventListener('pointerdown', () => {
    dragging = true;
  });
  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    if (pendingRebuild) {
      pendingRebuild = false;
      refreshControls();
    }
  });
}

function paintNote(): void {
  const note = $('strategy-note');
  note.hidden = racing;
  if (scenario.boarding.strategy === 'custom') {
    note.textContent = discovered
      ? `Discovered policy — ${discovered.description}.`
      : 'A policy found by the optimizer.';
    return;
  }
  const meta = STRATEGIES.find((s) => s.id === scenario.boarding.strategy);
  if (meta) note.textContent = meta.blurb;
}

function buildPresets(): void {
  const host = $('presets');
  host.replaceChildren();
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'preset';
    btn.textContent = p.name;
    btn.title = p.blurb;
    btn.addEventListener('click', () => {
      scenario = structuredClone(p.scenario);
      restart();
      invalidateAnalyses();
      refreshActiveView();
      refreshControls();
      paintNote();
      paintMasthead();
      $('preset-blurb').textContent = p.blurb;
      host.querySelectorAll('.preset').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
    });
    host.append(btn);
  }
  const blurb = document.createElement('p');
  blurb.id = 'preset-blurb';
  blurb.className = 'hint preset-blurb';
  host.append(blurb);
}

function buildOpponentPicker(): void {
  const select = $<HTMLSelectElement>('opponent');
  select.addEventListener('change', () => {
    opponent = select.value as StrategyId;
    // An opponent only exists in a race, so choosing one starts it. Otherwise
    // the control sits in the toolbar looking like the strategy picker and
    // doing nothing visible, because the lane it governs is not on screen.
    if (!racing) {
      racing = true;
      $<HTMLInputElement>('race').checked = true;
    }
    restart();
    paintNote();
  });
  paintOpponentPicker();
}

/**
 * Fills the opponent list, leaving out whatever lane A is already running.
 *
 * The two lanes share a seed and a population, so racing a strategy against
 * itself is not a close result — it is the identical run twice, down to the
 * pixel, and the verdict reads "dead heat". Offering the choice at all made the
 * race look broken, because the default opponent was the default strategy.
 */
function paintOpponentPicker(): void {
  const select = $<HTMLSelectElement>('opponent');
  const choices = STRATEGIES.filter((meta) => meta.id !== scenario.boarding.strategy);
  opponent = pickOpponent(scenario.boarding.strategy, opponent);
  // The optimizer can leave 'custom' here, which the list never offers.
  if (!choices.some((meta) => meta.id === opponent)) {
    opponent = choices[0]?.id ?? opponent;
  }

  select.replaceChildren();
  for (const meta of choices) {
    const option = document.createElement('option');
    option.value = meta.id;
    option.textContent = meta.name;
    option.selected = meta.id === opponent;
    select.append(option);
  }
}

// ---- wiring ----------------------------------------------------------------

$('play').addEventListener('click', () => setPlaying(!playing));

$('step').addEventListener('click', () => {
  // One second of simulated time per click reads better than one 0.25s tick.
  for (let i = 0; i < 1 / scenario.params.tick; i++) stepAll();
  // Pausing after the step, not before it: stepping to the end has to leave the
  // button offering a replay rather than a play that silently restarts. It
  // repaints too, so the explicit draw the step used to make is now its job.
  setPlaying(false);
});

$('reset').addEventListener('click', () => {
  setPlaying(false);
  rebuildLanes();
});

/**
 * Keyboard transport. Ignored while a control has focus, so typing a trial
 * count into a number field does not pause the simulation.
 */
document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

  const speedInput = $<HTMLInputElement>('speed');
  const nudge = (delta: number): void => {
    speed = Math.min(60, Math.max(1, speed + delta));
    speedInput.value = String(speed);
    $('speed-value').textContent = `${speed}×`;
  };

  if (event.key === 'Escape') {
    if (!$('analysis').hidden) setAnalysis(false);
    else if (!$('inspector').hidden) setInspector(false);
    return;
  }

  switch (event.key) {
    case ' ':
      event.preventDefault();
      setPlaying(!playing);
      break;
    case 'r':
    case 'R':
      setPlaying(false);
      rebuildLanes();
      break;
    case 'ArrowRight':
      event.preventDefault();
      nudge(4);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      nudge(-4);
      break;
    default:
      break;
  }
});

$<HTMLInputElement>('race').addEventListener('change', (e) => {
  racing = (e.target as HTMLInputElement).checked;
  restart();
  paintNote();
});

const speedInput = $<HTMLInputElement>('speed');
speedInput.addEventListener('input', () => {
  speed = Number(speedInput.value);
  $('speed-value').textContent = `${speed}×`;
});

function runComparison(): void {
  const button = $<HTMLButtonElement>('run-batch');
  const trials = budgetFor(precision).compare;
  const natural = $<HTMLInputElement>('natural-groups').checked;

  button.disabled = true;
  button.textContent = 'Working…';
  const started = performance.now();

  compute
    .compare(scenario, trials, natural)
    .then((results) => {
      const host = $('comparison');
      host.innerHTML = comparisonChart(results, scenario.boarding.strategy, chartWidth(host));

      const capped = results.reduce((n, r) => n + r.incompleteRuns, 0);
      const best = results[0];
      const worst = results.at(-1);

      if (capped > 0) {
        // Every strategy pins to the safety cap, which reads as a dead heat and
        // is not one. Say what happened instead of publishing the coincidence.
        $('batch-hint').innerHTML =
          `<strong>Not a measurement.</strong> ${capped} of ` +
          `${results.length * trials} runs hit the simulator's time cap without ` +
          `seating everyone, so these bars are the cap rather than boarding ` +
          `times. Reduce the load, bags or row count until runs complete.`;
      } else if (best && worst) {
        $('batch-hint').innerHTML =
          `<strong>${best.name}</strong> wins at ${formatDuration(best.median)} median, ` +
          `${formatDuration(worst.median - best.median)} faster than <strong>${worst.name}</strong> ` +
          `(${(worst.median / best.median).toFixed(2)}×). ` +
          `${trials} trials per strategy in ${Math.round(performance.now() - started)}ms. ` +
          `Whiskers show the interquartile range; where they overlap, the difference is not resolved.`;
      }
    })
    .catch((error: Error) => {
      $('batch-hint').textContent = `Comparison failed: ${error.message}`;
    })
    .finally(() => {
      button.disabled = false;
      button.textContent = 'Re-run';
    });
}

// ---- sweep and calibration --------------------------------------------------

function buildSweepPicker(): void {
  const select = $<HTMLSelectElement>('sweep-axis');
  select.replaceChildren();
  for (const axis of SWEEP_AXES) {
    const option = document.createElement('option');
    option.value = axis.param;
    option.textContent = axis.label;
    select.append(option);
  }
}

function runSweep(): void {
  const button = $<HTMLButtonElement>('run-sweep');
  const param = $<HTMLSelectElement>('sweep-axis').value as SweepParam;
  const axis = findAxis(param);
  const trials = budgetFor(precision).sweep;

  button.disabled = true;
  button.textContent = 'Working…';
  const started = performance.now();

  compute
    .sweep(scenario, trials, param)
    .then((result) => {
      const host = $('sweep');
      host.innerHTML = sweepChart(axis, result, chartWidth(host));

      const runs = axis.values.length * STRATEGIES.length * trials;
      $('sweep-hint').innerHTML =
        `${axis.blurb} <em>${runs.toLocaleString()} boardings in ` +
        `${Math.round(performance.now() - started)}ms.</em>`;
    })
    .catch((error: Error) => {
      $('sweep-hint').textContent = `Sweep failed: ${error.message}`;
    })
    .finally(() => {
      button.disabled = false;
      button.textContent = 'Re-run';
    });
}

function runFindings(): void {
  const button = $<HTMLButtonElement>('run-findings');
  button.disabled = true;
  button.textContent = 'Working…';
  const started = performance.now();

  compute
    .analyze(scenario, budgetFor(precision).findings)
    .then((analysis) => {
      renderFindings(analysis);
      $('findings-hint').innerHTML =
        `Each finding below changes one thing against your current settings and re-measures. ` +
        `<em>${analysis.trials} boardings per estimate, ${Math.round(performance.now() - started)}ms.</em>`;
    })
    .catch((error: Error) => {
      $('findings').textContent = `Analysis failed: ${error.message}`;
    })
    .finally(() => {
      button.disabled = false;
      button.textContent = 'Re-run';
    });
}

$('run-findings').addEventListener('click', runFindings);
$('run-batch').addEventListener('click', runComparison);
$('run-sweep').addEventListener('click', runSweep);
$('run-optimize').addEventListener('click', runSearch);
$('run-calibration').addEventListener('click', runCalibration);
$('sweep-axis').addEventListener('change', runSweep);
$('natural-groups').addEventListener('change', runComparison);

function renderFindings(analysis: AnalysisResult): void {
  const items = analysis.insights
    .map((insight) => {
      const worthless = insight.kind === 'lever' && insight.savingSeconds === 0;
      const cost = (insight.savingSeconds ?? 0) < 0;
      // Advisory levers are measured, not recommended, so they never get the
      // green treatment that reads as "do this".
      const cls = worthless
        ? 'inconclusive'
        : cost
          ? 'cost'
          : insight.advisory
            ? 'advisory'
            : insight.kind;
      return (
        `<li class="finding ${cls}">` +
        `<h3>${insight.title}</h3><p>${insight.detail}</p></li>`
      );
    })
    .join('');

  const switchButton =
    analysis.bestStrategy && !analysis.alreadyBest
      ? `<button id="adopt-best" class="btn btn-key">SWITCH TO ${strategyName(analysis.bestStrategy).toUpperCase()}</button>`
      : '';

  $('findings').innerHTML = `<ul class="findings-list">${items}</ul>${switchButton}`;

  const adopt = document.getElementById('adopt-best');
  adopt?.addEventListener('click', () => {
    if (!analysis.bestStrategy) return;
    scenario.boarding.strategy = analysis.bestStrategy;
    scenario.boarding.releaseGroups = naturalGroups(analysis.bestStrategy, {
      blocks: scenario.boarding.blocks,
    });
    setPlaying(false);
    rebuildLanes();
    refreshControls();
    paintNote();
    paintMasthead();
  });
}

// ---- precision -------------------------------------------------------------

let precision: Precision = 'standard';

/**
 * Analyses recompute when their panel is opened, or when the scenario or the
 * precision changes underneath them. Marking a panel stale rather than running
 * everything eagerly keeps the work to what is actually being looked at.
 */
const stale = new Set<string>(['compare', 'search', 'findings', 'sources', 'bench']);

function invalidateAnalyses(): void {
  stale.add('compare');
  stale.add('search');
  stale.add('findings');
  stale.add('sources');
  // The bench holds finished measurements; a scenario change does not age them.
}

function buildPrecision(): void {
  const host = $('precision');
  host.replaceChildren();

  const label = document.createElement('span');
  label.className = 'precision-label';
  label.textContent = 'Precision';
  host.append(label);

  for (const level of ['quick', 'standard', 'thorough'] as Precision[]) {
    const btn = document.createElement('button');
    btn.className = 'precision-step' + (level === precision ? ' active' : '');
    btn.textContent = PRECISION_LABELS[level];
    btn.title = PRECISION_HINT[level];
    btn.addEventListener('click', () => {
      if (precision === level) return;
      precision = level;
      buildPrecision();
      invalidateAnalyses();
      refreshActiveView();
    });
    host.append(btn);
  }
}

/** Recomputes whatever the open tab shows, if it has gone stale. */
function refreshActiveView(): void {
  const name = tabs.active;
  if (!stale.has(name)) return;
  stale.delete(name);
  switch (name) {
    case 'compare':
      runComparison();
      runSweep();
      break;
    case 'search':
      runSearch();
      break;
    case 'findings':
      runFindings();
      break;
    case 'sources':
      runCalibration();
      break;
    default:
      break;
  }
}

// ---- the bench -------------------------------------------------------------

let pins: Pin[] = loadPins();
/** Ids of the pins being compared; at most two, oldest dropped first. */
let selectedPins: string[] = [];

function paintBench(): void {
  renderBench($('bench'), pins, selectedPins, {
    onSelect(id) {
      selectedPins = selectedPins.includes(id)
        ? selectedPins.filter((p) => p !== id)
        : [...selectedPins, id].slice(-2);
      paintBench();
    },
    onRestore(pin) {
      scenario = structuredClone(pin.scenario);
      restart();
      refreshControls();
      paintNote();
      paintMasthead();
      tabs.show('this-run');
    },
    onDelete(id) {
      pins = pins.filter((p) => p.id !== id);
      selectedPins = selectedPins.filter((p) => p !== id);
      savePins(pins);
      paintBench();
    },
  });
  $('bench-hint').textContent = pins.length === 0 ? '' : `${pins.length} pinned`;
}

$('pin').addEventListener('click', () => {
  const button = $<HTMLButtonElement>('pin');
  button.disabled = true;
  button.textContent = 'Sampling…';

  // A pin is a measurement, not a snapshot of the run on screen, so it costs a
  // proper sample before it is worth keeping.
  compute
    .pin({ scenario, trials: budgetFor(precision).pin, createdAt: Date.now() })
    .then((pin) => {
      pins = [...pins.filter((p) => p.id !== pin.id), pin];
      selectedPins = [...selectedPins, pin.id].slice(-2);
      savePins(pins);
      paintBench();
      tabs.show('bench');
    })
    .catch((error: Error) => {
      $('bench-hint').textContent = `Pin failed: ${error.message}`;
    })
    .finally(() => {
      button.disabled = false;
      button.textContent = 'Pin run';
    });
});

/** The most recent search result, so it can be loaded into a lane. */
let discovered: OptimizeResult | null = null;

function runSearch(): void {
  const button = $<HTMLButtonElement>('run-optimize');
  const { searchCandidates: iterations, searchTrials: trials } = budgetFor(precision);

  button.disabled = true;
  const started = performance.now();
  const progressHost = $('opt-progress');
  const live: number[] = [];

  compute
    .optimize(
      scenario,
      { ...DEFAULT_OPTIMIZE_OPTIONS, iterations, trials, seed: scenario.seed * 7919 + 13 },
      (p) => {
        button.textContent = `${Math.round((p.iteration / p.iterations) * 100)}%`;
        live.push(p.best);
        progressHost.innerHTML = convergenceChart(live, null, chartWidth(progressHost));
      },
    )
    .then((result) => {
      discovered = result;
      const best = result.baselines[0];
      progressHost.innerHTML = convergenceChart(
        result.history,
        best?.mean ?? null,
        chartWidth(progressHost),
      );
      renderOptimizeResult(result, performance.now() - started);
    })
    .catch((error: Error) => {
      $('opt-result').textContent = `Search failed: ${error.message}`;
    })
    .finally(() => {
      button.disabled = false;
      button.textContent = 'Re-run';
    });
}

function renderOptimizeResult(result: OptimizeResult, elapsedMs: number): void {
  const best = result.baselines[0];
  const margin = best ? 1 - result.mean / best.mean : 0;
  const gate =
    result.releaseGroups === null
      ? 'a strictly ordered queue'
      : `${result.releaseGroups} gate group${result.releaseGroups === 1 ? '' : 's'}`;

  // A margin is only worth claiming if it clears the run-to-run noise. The
  // search has already picked the best of hundreds of candidates, so an
  // unqualified "X% faster" would be exactly the kind of number that fails to
  // reproduce.
  const verdict = !best
    ? 'Search complete.'
    : result.significant
      ? `Found a policy <strong>${(margin * 100).toFixed(1)}% faster</strong> than ${best.name}, ` +
        `the best named strategy under these settings — a real margin, ${formatDuration(best.mean - result.mean)} ` +
        `against a ±${(2 * result.marginStdError).toFixed(0)}s noise band.`
      : `<strong>No clear winner.</strong> The best policy found came within ` +
        `${Math.abs(margin * 100).toFixed(1)}% of ${best.name}, which is inside the ` +
        `±${(2 * result.marginStdError).toFixed(0)}s run-to-run noise — not a difference you could rely on.`;

  const weightRows = POLICY_KEYS.map((k) => {
    const v = result.weights[k];
    const bar = Math.round(Math.abs(v) * 100);
    return (
      `<tr><td>${k}</td><td class="weight-cell">` +
      `<span class="weight-bar ${v < 0 ? 'neg' : 'pos'}" style="width:${bar}%"></span>` +
      `</td><td>${v >= 0 ? '+' : ''}${v.toFixed(2)}</td></tr>`
    );
  }).join('');

  $('opt-result').innerHTML =
    `<p class="verdict-inline">${verdict}</p>` +
    `<dl class="policy-facts">` +
    `<dt>What it does</dt><dd>${result.description}</dd>` +
    `<dt>Held-out score</dt><dd>${formatDuration(result.mean)} over ${result.validationTrials} fresh boardings ` +
    `(scored ${formatDuration(result.trainMean)} during the search — a ${Math.abs(result.mean - result.trainMean).toFixed(0)}s optimism gap)</dd>` +
    `<dt>Constraint</dt><dd>${gate}, ` +
    `${scenario.boarding.familiesBoardTogether ? 'families kept together' : 'families split freely'}</dd>` +
    `<dt>Closest published method</dt><dd>${result.nearest.name} (distance ${result.nearest.distance.toFixed(2)})</dd>` +
    `</dl>` +
    `<table class="weights"><tbody>${weightRows}</tbody></table>` +
    `<div class="opt-actions"><button id="race-discovered">Race it against ${best?.name ?? 'the best named'}</button>` +
    `<span class="hint">${Math.round(elapsedMs)}ms</span></div>`;

  $('race-discovered').addEventListener('click', () => {
    if (!discovered) return;
    scenario.boarding.customWeights = discovered.weights;
    scenario.boarding.strategy = 'custom';
    opponent = discovered.baselines[0]?.strategy ?? 'steffen-perfect';
    racing = true;
    $<HTMLInputElement>('race').checked = true;
    setPlaying(false);
    // The baseline was chosen here, not in the dropdown; show it there too.
    paintOpponentPicker();
    rebuildLanes();
    refreshControls();
    paintNote();
    paintMasthead();
    $('lanes').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function runCalibration(): void {
  const button = $<HTMLButtonElement>('run-calibration');
  button.disabled = true;
  button.textContent = 'Working…';

  compute.calibrate(budgetFor(precision).calibrate).then((rows) => {
    const worst = Math.max(...rows.map((r) => Math.abs(r.error)));
    $('calibration').innerHTML =
      `<table class="calibration"><thead><tr>` +
      `<th>Method</th><th>Measured</th><th>Simulated</th><th>Error</th>` +
      `</tr></thead><tbody>` +
      rows
        .map((r) => {
          const pct = `${r.error >= 0 ? '+' : ''}${(r.error * 100).toFixed(0)}%`;
          const cls = Math.abs(r.error) <= 0.15 ? 'ok' : 'off';
          return (
            `<tr><td>${r.method}${r.note ? ` <span class="footnote" title="${r.note}">*</span>` : ''}</td>` +
            `<td>${formatDuration(r.measured)}</td>` +
            `<td>${formatDuration(r.simulated)}</td>` +
            `<td class="${cls}">${pct}</td></tr>`
          );
        })
        .join('') +
      `</tbody></table>` +
      rows
        .filter((r) => r.note)
        .map((r) => `<p class="hint footnote-body">* <strong>${r.method}:</strong> ${r.note}</p>`)
        .join('') +
      `<p class="hint">Largest deviation ${(worst * 100).toFixed(0)}%. The experiment ran each method once, with a stated uncertainty of about 10%.</p>`;
    })
    .catch((error: Error) => {
      $('calibration').textContent = `Calibration failed: ${error.message}`;
    })
    .finally(() => {
      button.disabled = false;
      button.textContent = 'Re-run';
    });
}

window.addEventListener('resize', () => {
  lanes.forEach((l) => l.resize());
  draw(true);
});

/** Colours the legend swatches from the canvas palette, not by hand. */
function paintLegend(): void {
  for (const swatch of document.querySelectorAll<HTMLElement>('.legend i')) {
    const key = swatch.dataset['key'];
    if (key && STATE_COLORS[key]) swatch.style.background = STATE_COLORS[key];
  }
}

/** Standing summary of the scenario, so the rail is not the only place it lives. */
function paintMasthead(): void {
  const seats = scenario.cabin.rows * 6 - scenario.cabin.firstClassRows * 2;
  const rows: [string, string][] = [
    ['rows', String(scenario.cabin.rows)],
    ['pax', String(Math.round(seats * scenario.population.loadFactor))],
    ['bags', scenario.population.meanBags.toFixed(1)],
    [
      'gate',
      scenario.boarding.releaseGroups === null
        ? 'strict'
        : `${scenario.boarding.releaseGroups} groups`,
    ],
    ['strategy', strategyName(scenario.boarding.strategy)],
  ];
  $('masthead-meta').innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
}

/**
 * Views are hidden with `hidden`, which zeroes their layout box. Anything that
 * measures itself against the DOM has to be redrawn once its view is visible.
 */
const tabs = createTabs($('tabs'), $('views'), (name) => {
  // The cabin is outside the tab system and always sized; only the per-run
  // charts live inside a view and need repainting once they are measurable.
  if (name === 'this-run') {
    paintCurve();
    paintHeatmaps();
    paintEquity();
  }
  // Opening a panel is the request. Nothing here needs a button pressed first.
  refreshActiveView();
});

// ---- overlays --------------------------------------------------------------

/**
 * Configuration is a panel, not a permanent rail. It sits between the two bars
 * so the transport stays live while it is open, and the cabin re-measures into
 * whatever width is left.
 */
function setInspector(open: boolean): void {
  $('inspector').hidden = !open;
  $('inspector-toggle').setAttribute('aria-expanded', String(open));
  // The viewport narrows when the drawer opens, so the canvas must re-measure.
  requestAnimationFrame(() => {
    lanes.forEach((l) => l.resize());
    draw(true);
  });
}

$('inspector-toggle').addEventListener('click', () =>
  setInspector($('inspector').hidden),
);
$('inspector-close').addEventListener('click', () => setInspector(false));

/**
 * Analysis comes over the top of the cabin rather than beside or below it.
 *
 * Everything in it is read rather than watched, and it wants the width; the
 * simulation carries on underneath and the transport stays reachable, so
 * closing it is never more than a keypress.
 */
function setAnalysis(open: boolean): void {
  $('analysis').hidden = !open;
  $('analysis-scrim').hidden = !open;
  $('analysis-toggle').setAttribute('aria-expanded', String(open));
  if (!open) return;

  // Charts size themselves from their container, which measures zero while the
  // sheet is hidden — so they are painted after it has been given a box.
  requestAnimationFrame(() => {
    tabs.show(tabs.active || 'this-run');
  });
}

$('analysis-toggle').addEventListener('click', () => setAnalysis($('analysis').hidden));
$('analysis-close').addEventListener('click', () => setAnalysis(false));
$('analysis-scrim').addEventListener('click', () => setAnalysis(false));

buildPresets();
buildPrecision();
buildOpponentPicker();
paintBench();
buildSweepPicker();
buildResearch($('research'));
refreshControls();
watchGestures();
paintNote();
paintLegend();
rebuildLanes();
paintMasthead();
tabs.show('this-run');
// Both overlays start shut: the simulation is the interface, and the panels
// over it are there when they are wanted.
setAnalysis(false);
setInspector(false);

// The plane is already boarding when you arrive. This is a simulator first —
// the interesting thing is watching it run, so it should not wait to be asked.
setPlaying(true);

requestAnimationFrame(tick);
