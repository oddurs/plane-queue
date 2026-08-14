import { maxDepth } from './cabin.ts';
import type {
  AgentState,
  Cabin,
  Metrics,
  Passenger,
  PassengerWait,
  SeatInterferenceCounts,
  SimParams,
} from './types.ts';
import type { Rng } from './rng.ts';

/**
 * Fixed-timestep boarding simulation.
 *
 * The cabin aisle is a one-dimensional lane of cells, one per seat row, and at
 * most one passenger may occupy a cell at a time. That single constraint is
 * what produces both interference types the literature cares about:
 *
 *  - Aisle interference: someone ahead has stopped to stow luggage, so everyone
 *    behind waits. Steffen & Hotchkiss (2011) measured this at ~5s per event
 *    and found it dominates total boarding time.
 *  - Seat interference: reaching a window or middle seat means already-seated
 *    neighbours must stand into the aisle, which blocks the aisle cell too.
 *    This is how a seat interference becomes an aisle interference.
 *
 * Both the animation and the headless batch drive this same `step()`, so the
 * picture on screen and the statistics can never disagree.
 */

export const DEFAULT_PARAMS: SimParams = {
  tick: 0.25,
  // Steffen & Hotchkiss estimate ~1s to walk past one row at full speed; 1.2s
  // is the value that best fits their five measured boarding times, and sits in
  // the range the cellular-automaton literature uses (~0.8 m/s over 32" pitch).
  walkTimePerRow: 1.2,
  // Calibrated so that stowing plus sitting plus one walk step costs ~5s of
  // aisle blockage for a typical passenger — the effective per-interference
  // time Steffen & Hotchkiss derive from their measured back-to-front run.
  stowTimeFirstBag: { min: 1.8, mode: 2.9, max: 5.0 },
  stowTimePerExtraBag: { min: 1.0, mode: 2.0, max: 3.6 },
  // ~2s per blocker, matching the paper's estimate for a seat interference.
  shuffleTimePerBlocker: { min: 1.2, mode: 2.0, max: 4.0 },
  binSearchTimePerRow: 0.8,
  binSearchRadius: 4,
  adjacentStowPenalty: 1.6,
  gateCheckWhenFull: true,
  partyStowShare: 0.45,
  assistanceSlowFactor: 2.5,
  baseSeatingTime: 1.0,
  childSeatingExtra: 2.0,
  maxSimSeconds: 7200,
};

/** Time resolution of the congestion heatmap, in seconds. */
const CONGESTION_BUCKET_SECONDS = 10;
/** Safety cap: 40 minutes of buckets is far past any realistic boarding. */
const MAX_CONGESTION_BUCKETS = 240;

export interface SimSnapshot {
  time: number;
  agents: AgentState[];
  seatedCount: number;
  boardedCount: number;
  total: number;
  done: boolean;
}

export class Simulation {
  readonly cabin: Cabin;
  readonly params: SimParams;
  readonly agents: AgentState[];

  private rng: Rng;
  private time = 0;
  /** Aisle cell occupancy: aisle[pos] holds the agent there, or null. */
  private aisle: (AgentState | null)[];
  /** Seats already taken, keyed row:letter — drives seat-interference counts. */
  private occupied = new Set<string>();
  /** Remaining overhead bag slots per row. */
  private binSlots: number[];
  /** Queue of agents waiting on the jetbridge, in boarding order. */
  private queue: AgentState[];
  private seatedCount = 0;
  /** Preboarders currently aboard but not yet seated; holds back the main queue. */
  private preboardersAboard = 0;

  private stallEvents = 0;
  private seatInterferences: SeatInterferenceCounts = {
    type1: 0,
    type2: 0,
    type3: 0,
    type4: 0,
  };
  private binSearches = 0;
  private gateChecked = 0;
  private curve: { t: number; seated: number }[] = [{ t: 0, seated: 0 }];
  /** Blocked passenger-seconds per aisle cell per time bucket, row-major. */
  private congestion: number[] = [];
  private congestionBuckets = 0;

  constructor(
    cabin: Cabin,
    order: { passenger: Passenger; group: number }[],
    params: SimParams,
    rng: Rng,
  ) {
    this.cabin = cabin;
    this.params = params;
    this.rng = rng;

    this.agents = order.map(({ passenger, group }, i) => ({
      passenger,
      state: 'queued' as const,
      pos: -1,
      timer: 0,
      order: i,
      group,
      fromPos: -1,
      stepDuration: 0,
      gateCheckedBags: 0,
      aisleTime: 0,
      blockedTime: 0,
      blocked: false,
      binOffset: 0,
    }));

    this.queue = [...this.agents];
    if (params.gateCheckWhenFull) this.gateCheckExcess();
    // Index 0 is the doorway; 1..rows sit alongside each seat row.
    this.aisle = new Array(cabin.config.rows + 1).fill(null);
    this.binSlots = new Array(cabin.config.rows + 1).fill(
      cabin.config.binSlotsPerRow,
    );
  }

  /**
   * Takes bags at the gate once the cabin cannot hold them.
   *
   * When the bins are going to run out, gate agents stop the last groups called
   * and tag their carry-ons. Working backwards from the end of the queue is what
   * actually happens — the people already down the jetbridge keep their bags,
   * and the ones still at the desk lose theirs. It is also why a heavily loaded
   * flight does not degrade without limit: past a point the marginal passenger
   * simply has nothing to stow.
   *
   * `bags` is the passenger's own record, so this is recorded as a count rather
   * than mutating the manifest the rest of the app compares against.
   */
  private gateCheckExcess(): void {
    const capacity = this.cabin.config.rows * this.cabin.config.binSlotsPerRow;
    let carried = this.agents.reduce((sum, a) => sum + a.passenger.bags, 0);

    for (let i = this.queue.length - 1; i >= 0 && carried > capacity; i--) {
      const agent = this.queue[i] as AgentState;
      // Preboarders are never asked to give up a bag.
      if (agent.group < 0) continue;
      const bags = agent.passenger.bags - agent.gateCheckedBags;
      if (bags <= 0) continue;
      const take = Math.min(bags, carried - capacity);
      agent.gateCheckedBags += take;
      this.gateChecked += take;
      carried -= take;
    }
  }

  get done(): boolean {
    return this.seatedCount >= this.agents.length;
  }

  get currentTime(): number {
    return this.time;
  }

  /** Seats filled so far, keyed `row:letter`. Read by the renderer. */
  get occupiedSeats(): ReadonlySet<string> {
    return this.occupied;
  }

  /**
   * Remaining overhead bag slots per row, indexed by aisle position. Bin
   * contention is simulated but was previously invisible; the diagram reads
   * this to show stowage filling up.
   */
  get remainingBinSlots(): readonly number[] {
    return this.binSlots;
  }

  snapshot(): SimSnapshot {
    return {
      time: this.time,
      agents: this.agents,
      seatedCount: this.seatedCount,
      boardedCount: this.agents.length - this.queue.length,
      total: this.agents.length,
      done: this.done,
    };
  }

  /** Advances the simulation by one tick. Returns false once boarding is over. */
  step(): boolean {
    if (this.done || this.time >= this.params.maxSimSeconds) return false;

    const dt = this.params.tick;
    this.time += dt;

    this.admitFromQueue();

    // Walk the aisle front-first so a passenger who vacates a cell this tick
    // frees it for the passenger behind, which is how a queue actually drains.
    for (let pos = this.aisle.length - 1; pos >= 0; pos--) {
      const agent = this.aisle[pos];
      if (agent) this.advance(agent, dt);
    }

    for (const agent of this.agents) {
      if (agent.state !== 'queued' && agent.state !== 'seated') {
        agent.aisleTime += dt;
        if (agent.blocked) {
          agent.blockedTime += dt;
          this.recordCongestion(agent.pos, dt);
        }
      }
    }

    this.recordCurve();
    return !this.done;
  }

  /**
   * Accumulates blocked time into the (row, time-bucket) grid backing the
   * congestion heatmap. The grid grows a column at a time as boarding runs on,
   * so a long boarding costs no more memory per unit time than a short one.
   */
  private recordCongestion(pos: number, dt: number): void {
    if (pos < 1) return;
    const rows = this.cabin.config.rows;
    const bucket = Math.floor(this.time / CONGESTION_BUCKET_SECONDS);
    if (bucket >= MAX_CONGESTION_BUCKETS) return;

    while (bucket >= this.congestionBuckets) {
      this.congestion.length += rows;
      this.congestion.fill(0, this.congestionBuckets * rows, this.congestion.length);
      this.congestionBuckets++;
    }
    const i = bucket * rows + (pos - 1);
    this.congestion[i] = (this.congestion[i] as number) + dt;
  }

  /**
   * Samples the boarding curve. Recording every tick would add thousands of
   * points the chart cannot resolve, so only changes in the seated count are
   * kept, plus a periodic sample so long stalls still show as flat stretches.
   */
  private recordCurve(): void {
    const last = this.curve.at(-1);
    const changed = last?.seated !== this.seatedCount;
    const stale = last !== undefined && this.time - last.t >= 2;
    if (changed || stale || this.done) {
      this.curve.push({ t: this.time, seated: this.seatedCount });
    }
  }

  /** Runs to completion and returns the collected metrics. */
  run(): Metrics {
    while (this.step()) {
      /* advance until boarding completes or the safety cap trips */
    }
    return this.metrics();
  }

  /**
   * Lets the next passenger aboard whenever the doorway is clear.
   *
   * Ordinary release groups deliberately have no gating effect. At a real gate
   * the line is continuous — the agent calls the next group while the previous
   * one is still walking down the jetbridge — so the only thing grouping
   * actually changes is that order is no longer enforced *within* a group. That
   * is modelled in `groups.ts` by shuffling inside each group, which is what
   * makes coarse grouping erode a fine-grained strategy.
   *
   * Preboarding (group -1) is the exception, and is gated. The whole point of
   * boarding passengers who need assistance first is that they get a clear
   * aisle; letting the main queue stack up behind someone moving at half speed
   * would model the opposite of what the policy is for.
   */
  private admitFromQueue(): void {
    const next = this.queue[0];
    if (!next) return;
    if (this.aisle[0] !== null) return;
    if (next.group >= 0 && this.preboardersAboard > 0) return;

    if (next.group < 0) this.preboardersAboard++;
    this.queue.shift();
    next.state = 'walking';
    next.fromPos = 0;
    next.pos = 0;
    next.timer = this.walkTime(next, 1);
    next.stepDuration = next.timer;
    this.aisle[0] = next;
  }

  /**
   * Time to walk into `pos`. Exit rows have noticeably greater pitch, so the
   * stretch of aisle beside them genuinely takes longer to cover.
   */
  private walkTime(agent: AgentState, pos: number): number {
    const p = agent.passenger;
    const assist = p.needsAssistance ? this.params.assistanceSlowFactor : 1;
    const pitch = this.cabin.rowPitch[pos - 1] ?? 1;
    return this.params.walkTimePerRow * p.slowFactor * assist * pitch;
  }

  private advance(agent: AgentState, dt: number): void {
    agent.timer -= dt;
    if (agent.timer > 0) return;

    switch (agent.state) {
      case 'walking':
        this.tryStep(agent);
        break;
      case 'stowing':
        this.beginSeating(agent);
        break;
      case 'shuffling':
        this.sit(agent);
        break;
      default:
        break;
    }
  }

  private tryStep(agent: AgentState): void {
    const targetRow = agent.passenger.seat.row;

    if (agent.pos === targetRow) {
      this.beginStowing(agent);
      return;
    }

    const nextPos = agent.pos + 1;
    if (nextPos >= this.aisle.length || this.aisle[nextPos] !== null) {
      // Blocked. Count one interference per episode, not per tick.
      if (!agent.blocked) {
        agent.blocked = true;
        this.stallEvents++;
      }
      return;
    }

    agent.blocked = false;
    this.aisle[agent.pos] = null;
    agent.fromPos = agent.pos;
    agent.pos = nextPos;
    this.aisle[nextPos] = agent;
    agent.timer = this.walkTime(agent, nextPos + 1);
    agent.stepDuration = agent.timer;
  }

  private beginStowing(agent: AgentState): void {
    agent.blocked = false;
    const bags = agent.passenger.bags - agent.gateCheckedBags;

    if (bags === 0) {
      this.beginSeating(agent);
      return;
    }

    const row = agent.passenger.seat.row;
    const binRow = this.findBin(row, bags);
    agent.binOffset = binRow === null ? this.params.binSearchRadius : Math.abs(binRow - row);
    if (agent.binOffset > 0) this.binSearches++;

    if (binRow !== null) {
      this.binSlots[binRow] = (this.binSlots[binRow] as number) - bags;
    }

    let t = this.rng.triangular(this.params.stowTimeFirstBag);
    for (let i = 1; i < bags; i++) {
      t += this.rng.triangular(this.params.stowTimePerExtraBag);
    }
    // Hunting for space keeps the aisle blocked for longer. Modelled as extra
    // time in place rather than literal backtracking: the aisle is forward-only
    // and the dominant real-world effect is the extra blockage, not the path.
    t += agent.binOffset * this.params.binSearchTimePerRow;

    // Elbow room at the bins. Without this the model rewards packing boarders
    // into neighbouring rows, which is exactly the crowding Steffen's two-row
    // spacing was designed to avoid.
    if (this.hasAdjacentStower(agent.pos)) t += this.params.adjacentStowPenalty;

    // A family does not queue at the bin one at a time: whoever gets there
    // first takes the bags. A second member arriving to the same row hands
    // theirs over rather than repeating the whole operation.
    if (this.partyAlreadyStowing(agent)) t *= this.params.partyStowShare;

    agent.state = 'stowing';
    agent.timer = t;
  }

  /** True when someone from the same party is already at the bins here. */
  private partyAlreadyStowing(agent: AgentState): boolean {
    const party = agent.passenger.partyId;
    if (party === null) return false;
    for (const pos of [agent.pos - 1, agent.pos, agent.pos + 1]) {
      const other = this.aisle[pos];
      if (
        other &&
        other !== agent &&
        other.state === 'stowing' &&
        other.passenger.partyId === party
      ) {
        return true;
      }
    }
    return false;
  }

  private hasAdjacentStower(pos: number): boolean {
    for (const neighbour of [this.aisle[pos - 1], this.aisle[pos + 1]]) {
      if (neighbour && neighbour.state === 'stowing') return true;
    }
    return false;
  }

  /** Nearest row with room for `bags`, searching outward from `row`. */
  private findBin(row: number, bags: number): number | null {
    if ((this.binSlots[row] ?? 0) >= bags) return row;
    for (let d = 1; d <= this.params.binSearchRadius; d++) {
      // Prefer looking aft: the passenger is walking that way anyway.
      for (const candidate of [row + d, row - d]) {
        if (candidate < 1 || candidate >= this.binSlots.length) continue;
        if ((this.binSlots[candidate] as number) >= bags) return candidate;
      }
    }
    return null;
  }

  private beginSeating(agent: AgentState): void {
    const seat = agent.passenger.seat;
    const blocked = this.blockedDepths(seat.row, seat.side, seat.depth);

    let t = this.seatingTime(agent);
    if (blocked.length > 0) {
      this.recordSeatInterference(seat.depth, blocked);
      for (let i = 0; i < blocked.length; i++) {
        t += this.rng.triangular(this.params.shuffleTimePerBlocker);
      }
    }

    agent.state = 'shuffling';
    agent.timer = t;
  }

  private seatingTime(agent: AgentState): number {
    const p = agent.passenger;
    let t = this.params.baseSeatingTime;
    if (p.isChild) t += this.params.childSeatingExtra;
    if (p.needsAssistance) t *= this.params.assistanceSlowFactor;
    return t;
  }

  /** Depths of seated passengers between this seat and the aisle. */
  private blockedDepths(row: number, side: string, depth: number): number[] {
    const depths: number[] = [];
    for (const seat of this.cabin.seatsByRow[row - 1] ?? []) {
      if (seat.side !== side || seat.depth >= depth) continue;
      if (this.occupied.has(`${seat.row}:${seat.letter}`)) depths.push(seat.depth);
    }
    return depths;
  }

  /**
   * The standard four-type taxonomy, keyed on the target seat and exactly which
   * neighbours are in the way. First-class 2-2 rows only have depths 0 and 1,
   * so they can only ever produce type 1.
   */
  private recordSeatInterference(depth: number, blocked: number[]): void {
    if (depth === 1) {
      // Heading for a middle seat past an occupied aisle seat.
      this.seatInterferences.type1++;
    } else if (blocked.length >= 2) {
      // Window seat, both aisle and middle occupied.
      this.seatInterferences.type4++;
    } else if (blocked[0] === 0) {
      // Window seat past an occupied aisle seat, middle empty.
      this.seatInterferences.type2++;
    } else {
      // Window seat past an occupied middle seat, aisle empty.
      this.seatInterferences.type3++;
    }
  }

  private sit(agent: AgentState): void {
    const seat = agent.passenger.seat;
    this.occupied.add(`${seat.row}:${seat.letter}`);
    if (this.aisle[agent.pos] === agent) this.aisle[agent.pos] = null;
    if (agent.group < 0) this.preboardersAboard--;
    agent.state = 'seated';
    agent.pos = -1;
    agent.blocked = false;
    this.seatedCount++;
  }

  metrics(): Metrics {
    // Only passengers who have actually boarded, so the figure stays meaningful
    // mid-run instead of being dragged to zero by everyone still at the gate.
    const boarded = this.agents.filter((a) => a.state !== 'queued');
    const aisleTimes = boarded.map((a) => a.aisleTime);
    const waits: PassengerWait[] = boarded.map((a) => ({
      row: a.passenger.seat.row,
      depth: a.passenger.seat.depth,
      maxDepth: maxDepth(this.cabin, a.passenger.seat.row),
      partyId: a.passenger.partyId,
      needsAssistance: a.passenger.needsAssistance,
      seconds: a.aisleTime,
      blocked: a.blockedTime,
    }));
    const sorted = [...aisleTimes].sort((a, b) => a - b);
    const at = (q: number): number =>
      sorted.length === 0
        ? 0
        : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number);

    const si = this.seatInterferences;
    return {
      complete: this.done,
      totalTime: this.time,
      stallEvents: this.stallEvents,
      seatInterferences: { ...si },
      seatInterferenceTotal: si.type1 + si.type2 + si.type3 + si.type4,
      binSearches: this.binSearches,
      gateChecked: this.gateChecked,
      aisleTimes,
      waits,
      meanAisleTime: aisleTimes.reduce((s, v) => s + v, 0) / (aisleTimes.length || 1),
      medianAisleTime: at(0.5),
      totalBlockedSeconds: this.agents.reduce((s, a) => s + a.blockedTime, 0),
      curve: this.curve,
      congestion: {
        rows: this.cabin.config.rows,
        bucketSeconds: CONGESTION_BUCKET_SECONDS,
        buckets: this.congestionBuckets,
        data: this.congestion,
        peak: this.congestion.reduce((m, v) => (v > m ? v : m), 0),
      },
    };
  }
}
