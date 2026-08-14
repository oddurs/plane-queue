import { buildCabin } from '../engine/cabin.ts';
import { createSimulation, type Scenario } from '../engine/run.ts';
import { strategyName } from '../engine/strategies.ts';
import type { Simulation } from '../engine/sim.ts';
import type { Cabin, Metrics, StrategyId } from '../engine/types.ts';
import { CabinRenderer } from '../render/cabin-canvas.ts';
import { formatDuration } from '../engine/stats.ts';

/**
 * One cabin under simulation, with its own canvas and readout.
 *
 * The app runs either a single lane or two side by side. Two lanes share a
 * scenario and seed and differ only in strategy, so they board the identical
 * passengers with the identical bags — the comparison is exact, not statistical.
 */
export class Lane {
  readonly root: HTMLElement;
  sim!: Simulation;
  cabin!: Cabin;
  /** Simulated seconds at which this lane finished, or null while running. */
  finishTime: number | null = null;

  private canvas: HTMLCanvasElement;
  private renderer: CabinRenderer;
  private nameEl: HTMLElement;
  private timeEl: HTMLElement;
  private statsEl: HTMLElement;
  /** Value nodes, kept so updates rewrite text instead of rebuilding the DOM. */
  private statCells = new Map<string, HTMLElement>();

  constructor(
    scenario: Scenario,
    public strategy: StrategyId,
    public readonly color: string,
    showHeader: boolean,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'lane';

    const head = document.createElement('div');
    head.className = 'lane-head';
    head.hidden = !showHeader;
    this.nameEl = document.createElement('span');
    this.nameEl.className = 'lane-name';
    this.nameEl.style.color = color;
    this.timeEl = document.createElement('span');
    this.timeEl.className = 'lane-time';
    head.append(this.nameEl, this.timeEl);

    const wrap = document.createElement('div');
    wrap.className = 'canvas-wrap';
    this.canvas = document.createElement('canvas');
    wrap.append(this.canvas);

    this.statsEl = document.createElement('div');
    this.statsEl.className = 'readout';

    this.root.append(head, wrap, this.statsEl);
    this.buildStats();
    this.renderer = new CabinRenderer(this.canvas);
    this.rebuild(scenario, strategy);
  }

  rebuild(scenario: Scenario, strategy: StrategyId): void {
    this.strategy = strategy;
    this.cabin = buildCabin(scenario.cabin);
    this.sim = createSimulation({
      ...scenario,
      boarding: { ...scenario.boarding, strategy },
    });
    this.finishTime = null;
    this.alive = true;
    this.nameEl.textContent = strategyName(strategy);
  }

  /** True while this lane still has ticks left to run. */
  private alive = true;

  /** Advances one tick. Returns false once this lane has finished boarding. */
  step(): boolean {
    this.alive = this.sim.step();
    if (!this.alive && this.finishTime === null) this.finishTime = this.sim.currentTime;
    return this.alive;
  }

  get done(): boolean {
    return this.sim.done;
  }

  metrics(): Metrics {
    return this.sim.metrics();
  }

  resize(): void {
    this.renderer.resize(this.cabin);
  }

  draw(): void {
    this.renderer.draw(
      this.cabin,
      this.sim.snapshot(),
      this.sim.occupiedSeats,
      this.sim.remainingBinSlots,
    );
  }

  /**
   * Redraws the numbers.
   *
   * The cells are built once and only their text is rewritten. Replacing the
   * strip's innerHTML several times a second tore down and rebuilt the whole
   * subtree, which read as a flicker.
   */
  updateStats(): void {
    const snap = this.sim.snapshot();
    const m = this.sim.metrics();

    this.timeEl.textContent = formatDuration(snap.time);
    this.timeEl.classList.toggle('finished', this.sim.done);
    // A run stopped by the safety cap is not a boarding time; the tick that
    // marks completion must not appear on it.
    this.timeEl.classList.toggle('capped', !m.complete && snap.time > 0 && !this.alive);

    this.setStat('elapsed', formatDuration(snap.time));
    this.setStat('seated', `${snap.seatedCount}/${snap.total}`);
    // A share, not a raw event count: "62% of time aboard was spent standing
    // still" is something a person can act on; "1712 stalls" is telemetry.
    const aboard = m.aisleTimes.reduce((sum, v) => sum + v, 0);
    const waiting = aboard > 0 ? m.totalBlockedSeconds / aboard : 0;
    this.setStat('waiting', `${Math.round(waiting * 100)}%`);
    this.setStat('shuffles', String(m.seatInterferenceTotal));
    this.setStat('bins', String(m.binSearches));
    this.setStat('gatechecked', String(m.gateChecked));
    this.setStat('wait', formatDuration(m.medianAisleTime));
    // Unit in the label, number in the value — a two-word value wraps badly in
    // a narrow lane.
    this.setStat('delay', String(Math.round(m.totalBlockedSeconds / 60)));
  }

  private setStat(key: string, value: string): void {
    const cell = this.statCells.get(key);
    if (cell && cell.textContent !== value) cell.textContent = value;
  }

  private buildStats(): void {
    const cells: [string, string][] = [
      ['elapsed', 'Elapsed'],
      ['seated', 'Seated'],
      ['waiting', 'Waiting'],
      ['shuffles', 'Shuffles'],
      ['bins', 'Bin hunts'],
      ['gatechecked', 'Gate-checked'],
      ['wait', 'Med. wait'],
      // Short enough to survive a half-width lane without an ellipsis.
      ['delay', 'Delay min'],
    ];
    this.statsEl.replaceChildren();
    this.statCells.clear();
    for (const [key, label] of cells) {
      const cell = document.createElement('div');
      cell.className = 'stat';
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('strong');
      value.textContent = '–';
      cell.append(name, value);
      this.statsEl.append(cell);
      this.statCells.set(key, value);
    }
  }
}
