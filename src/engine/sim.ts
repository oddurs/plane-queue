import { maxDepth } from './cabin.ts';
import type {
  AgentState,
  AssistanceKind,
  Cabin,
  CrewMember,
  Metrics,
  Passenger,
  PassengerWait,
  SeatInterferenceCounts,
  Seat,
  SimParams,
} from './types.ts';
import { ASSISTANCE_KINDS } from './types.ts';
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
  // An aisle chair is pushed, turned at every row, and cannot be hurried.
  aisleChairSlowFactor: 3.4,
  minorSlowFactor: 1.4,
  // Two: one to take the shoulders, one the legs. It is a lift, not a hand.
  escortsPerAisleChair: 2,
  // Transfers are slow, and they are the reason preboarding exists at all.
  aisleChairTransferTime: { min: 45, mode: 75, max: 140 },
  doorTransferTime: { min: 8, mode: 14, max: 25 },
  crewPassTime: 2.5,
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
  /** Escorts currently aboard or on their way off; `pos < 0` means ashore. */
  crew: CrewMember[];
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
  /**
   * Aisle cell occupancy. A cell holds a passenger or a crew escort, and crew
   * walking back to the door move the opposite way to everyone else.
   */
  private aisle: (AgentState | CrewMember | null)[];
  /**
   * Escorts walking back to the door, held apart from the boarding stream.
   *
   * An aisle is single file for people going the same way, but somebody can
   * press into a row to let one person by — which is exactly what happens when
   * crew leave through a boarding queue. Modelling the exit as a second lane
   * costs both parties time whenever they share a cell and, unlike trying to
   * squeeze them through the inbound queue, can never gridlock: this lane only
   * ever drains toward the door.
   */
  private exitLane: (CrewMember | null)[];
  /** Seats already taken, keyed row:letter — drives seat-interference counts. */
  private occupied = new Set<string>();
  /** Remaining overhead bag slots per row. */
  private binSlots: number[];
  /** Queue of agents waiting on the jetbridge, in boarding order. */
  private queue: AgentState[];
  private seatedCount = 0;
  /** Preboarders currently aboard but not yet seated; holds back the main queue. */
  private preboardersAboard = 0;
  /** Every escort this boarding needs, whether or not they are aboard yet. */
  readonly crew: CrewMember[] = [];
  /** Escorts at the door whose passenger is already aboard. */
  private crewQueue: CrewMember[] = [];
  private crewAboard = 0;
  private crewTransfers = 0;
  private crewPassEvents = 0;
  private crewAboardSeconds = 0;
  /** When the last passenger sat, and when the last escort stepped off. */
  private allSeatedAt: number | null = null;
  private crewAshoreAt: number | null = null;
  /** Occupants already moved this tick, so a swap cannot move one twice. */
  private stepped = new Set<AgentState | CrewMember>();

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
      kind: 'passenger' as const,
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
      displaced: [],
    }));

    this.queue = [...this.agents];
    if (params.gateCheckWhenFull) this.gateCheckExcess();
    // Index 0 is the doorway; 1..rows sit alongside each seat row.
    this.aisle = new Array(cabin.config.rows + 1).fill(null);
    this.exitLane = new Array(cabin.config.rows + 1).fill(null);
    this.binSlots = new Array(cabin.config.rows + 1).fill(
      cabin.config.binSlotsPerRow,
    );
    this.buildCrew();
  }

  /**
   * Rosters the escorts every aisle-chair passenger needs.
   *
   * They station themselves in the cells immediately doorward of the seat row,
   * because that is where they walked in from and where they stand to make the
   * lift — so a transfer blocks a short stretch of aisle, not one cell.
   */
  private buildCrew(): void {
    let id = 0;
    for (const agent of this.agents) {
      if (agent.passenger.assistance !== 'aisle-chair') continue;
      const row = agent.passenger.seat.row;
      for (let i = 0; i < this.params.escortsPerAisleChair; i++) {
        this.crew.push({
          kind: 'crew',
          id: id++,
          clientId: agent.passenger.id,
          state: 'waiting',
          heading: 1,
          lane: 'aisle',
          station: Math.max(0, row - 1 - i),
          pos: -1,
          fromPos: -1,
          stepDuration: 0,
          timer: 0,
          blocked: false,
          aboardTime: 0,
        });
      }
    }
  }

  /** Escorts rostered for one passenger. */
  private crewFor(passengerId: number): CrewMember[] {
    return this.crew.filter((c) => c.clientId === passengerId);
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

  /**
   * Boarding is over when everyone is seated *and* the aisle is empty.
   *
   * Escorts who brought an aisle chair aboard still have to walk back out, and
   * until they have, the aircraft is not ready. Stopping the clock at the last
   * passenger would hide the whole cost of the thing preboarding exists for.
   */
  get done(): boolean {
    return this.seatedCount >= this.agents.length && this.crewAboard === 0;
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
      crew: this.crew,
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
    this.stepped.clear();

    // Walk the aisle front-first so a passenger who vacates a cell this tick
    // frees it for the passenger behind, which is how a queue actually drains.
    // Escorts heading the other way are handled in the same sweep; a swap marks
    // both parties so neither moves twice in one tick.
    // Escorts leaving first and from the door backwards, so a cell freed this
    // tick is available to the one behind.
    for (let pos = 0; pos < this.exitLane.length; pos++) {
      const escort = this.exitLane[pos];
      if (escort) this.advance(escort, dt);
    }

    for (let pos = this.aisle.length - 1; pos >= 0; pos--) {
      const occupant = this.aisle[pos];
      if (occupant && !this.stepped.has(occupant)) this.advance(occupant, dt);
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

    for (const member of this.crew) {
      if (member.pos < 0) continue;
      member.aboardTime += dt;
      this.crewAboardSeconds += dt;
      if (member.blocked) this.recordCongestion(member.pos, dt);
    }

    if (this.allSeatedAt === null && this.seatedCount >= this.agents.length) {
      this.allSeatedAt = this.time;
    }
    if (this.crewAshoreAt === null && this.crewAboard === 0 && this.allSeatedAt !== null) {
      this.crewAshoreAt = this.time;
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
    if (this.aisle[0] !== null) return;

    // Escorts follow their passenger straight down the jetbridge — nobody else
    // is let between them and the chair they are pushing.
    const escort = this.crewQueue[0];
    if (escort) {
      this.crewQueue.shift();
      const client = this.agents.find((a) => a.passenger.id === escort.clientId);
      // If the transfer somehow finished without them, they never board.
      if (!client || client.state === 'seated') {
        escort.state = 'ashore';
        return;
      }
      escort.state = 'escorting';
      escort.heading = 1;
      escort.fromPos = 0;
      escort.pos = 0;
      escort.timer = this.crewWalkTime(1);
      escort.stepDuration = escort.timer;
      this.aisle[0] = escort;
      this.crewAboard++;
      return;
    }

    const next = this.queue[0];
    if (!next) return;
    if (next.group >= 0 && this.preboardersAboard > 0) return;

    if (next.group < 0) this.preboardersAboard++;
    this.queue.shift();
    next.state = 'walking';
    next.fromPos = 0;
    next.pos = 0;
    next.timer = this.walkTime(next, 1);
    // Getting out of your own chair happens in the doorway, with the whole
    // queue waiting behind you.
    if (next.passenger.assistance === 'own-wheelchair') {
      next.timer += this.rng.triangular(this.params.doorTransferTime);
    }
    next.stepDuration = next.timer;
    this.aisle[0] = next;

    // The chair is aboard; its escorts queue at the door behind it.
    if (next.passenger.assistance === 'aisle-chair') {
      this.crewQueue.push(...this.crewFor(next.passenger.id));
    }
  }

  /**
   * Time to walk into `pos`. Exit rows have noticeably greater pitch, so the
   * stretch of aisle beside them genuinely takes longer to cover.
   */
  private walkTime(agent: AgentState, pos: number): number {
    const p = agent.passenger;
    const pitch = this.cabin.rowPitch[pos - 1] ?? 1;
    return this.params.walkTimePerRow * p.slowFactor * this.assistFactor(p.assistance) * pitch;
  }

  /** How much slower this kind of assistance makes the trip down the aisle. */
  private assistFactor(kind: AssistanceKind): number {
    switch (kind) {
      case 'aisle-chair':
        return this.params.aisleChairSlowFactor;
      case 'own-wheelchair':
      case 'reduced-mobility':
        return this.params.assistanceSlowFactor;
      case 'minor':
        return this.params.minorSlowFactor;
      default:
        return 1;
    }
  }

  /** Crew move at an unencumbered walking pace, in either direction. */
  private crewWalkTime(pos: number): number {
    const pitch = this.cabin.rowPitch[pos - 1] ?? 1;
    return this.params.walkTimePerRow * pitch;
  }

  private advance(occupant: AgentState | CrewMember, dt: number): void {
    occupant.timer -= dt;
    if (occupant.timer > 0) return;

    if (occupant.kind === 'crew') {
      this.advanceCrew(occupant);
      return;
    }

    switch (occupant.state) {
      case 'walking':
        this.tryStep(occupant);
        break;
      case 'stowing':
        this.beginSeating(occupant);
        break;
      case 'shuffling':
        this.sit(occupant);
        break;
      default:
        break;
    }
  }

  /**
   * One escort's turn: aft behind the chair, hold for the lift, then forward
   * to the door and off.
   */
  private advanceCrew(member: CrewMember): void {
    if (member.state === 'escorting') {
      // Walk aft until the station beside the row, or until the chair ahead
      // stops them — either way they hold and wait for the transfer.
      if (member.pos >= member.station) {
        member.state = 'transferring';
        member.blocked = false;
        return;
      }
      this.tryWalk(member, 1);
      return;
    }

    if (member.state === 'transferring') return;

    if (member.state === 'leaving') {
      if (member.lane !== 'exit' && !this.enterExitLane(member)) return;
      this.walkOut(member);
    }
  }

  /** Turns an escort round once their passenger is down in the seat. */
  private releaseCrew(clientId: number): void {
    for (const member of this.crewFor(clientId)) {
      if (member.state === 'ashore') continue;
      if (member.pos < 0) {
        // Never made it aboard before the transfer finished.
        member.state = 'ashore';
        this.crewQueue = this.crewQueue.filter((c) => c !== member);
        continue;
      }
      // Turned round, but still in the boarding stream: crossing into the
      // outbound lane is itself a move, and it can be blocked by an escort
      // already walking out through the same stretch of aisle.
      member.state = 'leaving';
      member.heading = -1;
      member.blocked = false;
      member.timer = 0;
      member.stepDuration = 0;
    }
  }

  private tryStep(agent: AgentState): void {
    if (agent.pos === agent.passenger.seat.row) {
      this.beginStowing(agent);
      return;
    }
    this.tryWalk(agent, 1);
  }

  /**
   * Moves one occupant a single cell, or records that it could not.
   */
  private tryWalk(occupant: AgentState | CrewMember, heading: 1 | -1): void {
    const nextPos = occupant.pos + heading;
    if (nextPos < 0 || nextPos >= this.aisle.length) {
      this.markBlocked(occupant);
      return;
    }

    if (this.aisle[nextPos]) {
      this.markBlocked(occupant);
      return;
    }

    this.moveTo(occupant, nextPos);
  }

  private moveTo(occupant: AgentState | CrewMember, nextPos: number): void {
    occupant.blocked = false;
    this.aisle[occupant.pos] = null;
    occupant.fromPos = occupant.pos;
    occupant.pos = nextPos;
    this.aisle[nextPos] = occupant;
    occupant.timer = this.stepTime(occupant, nextPos + 1);
    occupant.stepDuration = occupant.timer;
    this.stepped.add(occupant);
  }

  /**
   * Steps an escort out of the boarding stream and into the outbound lane.
   *
   * Only one escort can hold a cell of that lane, so a second transfer finishing
   * beside a colleague already walking out has to wait its turn — standing in
   * the aisle, in everyone's way, which is precisely what happens.
   */
  private enterExitLane(escort: CrewMember): boolean {
    if (this.exitLane[escort.pos] !== null) {
      this.markBlocked(escort);
      return false;
    }
    if (this.aisle[escort.pos] === escort) this.aisle[escort.pos] = null;
    this.exitLane[escort.pos] = escort;
    escort.lane = 'exit';
    escort.blocked = false;
    return true;
  }

  /**
   * One step of an escort's walk back to the door.
   *
   * They are held up only by each other. Sharing a cell with somebody still
   * boarding costs them both a moment — one of them has to press into a row —
   * and that delay, repeated down the length of a full aisle, is the real price
   * of putting crew aboard and then taking them back out again.
   */
  private walkOut(escort: CrewMember): void {
    const nextPos = escort.pos - 1;
    if (nextPos < 0) {
      this.stepOff(escort);
      return;
    }
    if (this.exitLane[nextPos] !== null) {
      this.markBlocked(escort);
      return;
    }

    if (this.exitLane[escort.pos] === escort) this.exitLane[escort.pos] = null;
    escort.blocked = false;
    escort.fromPos = escort.pos;
    escort.pos = nextPos;
    this.exitLane[nextPos] = escort;
    escort.timer = this.crewWalkTime(nextPos + 1);

    const met = this.aisle[nextPos];
    if (met && this.yielding(met)) {
      escort.timer += this.params.crewPassTime;
      this.delay(met, this.params.crewPassTime);
      this.crewPassEvents++;
    }
    escort.stepDuration = escort.timer;
    this.stepped.add(escort);
  }

  /** True when this occupant is on the move, so can step aside rather than block. */
  private yielding(occupant: AgentState | CrewMember): boolean {
    return occupant.kind === 'passenger'
      ? occupant.state === 'walking'
      : occupant.state === 'escorting';
  }

  /** Holds someone up in place without moving them. */
  private delay(occupant: AgentState | CrewMember, seconds: number): void {
    occupant.timer += seconds;
    occupant.stepDuration = Math.max(occupant.stepDuration, occupant.timer);
    this.stepped.add(occupant);
  }

  /** Takes an escort off the aircraft, freeing whatever cell they held. */
  private stepOff(escort: CrewMember): void {
    if (this.aisle[escort.pos] === escort) this.aisle[escort.pos] = null;
    if (this.exitLane[escort.pos] === escort) this.exitLane[escort.pos] = null;
    escort.pos = -1;
    escort.fromPos = -1;
    escort.blocked = false;
    escort.lane = 'aisle';
    escort.state = 'ashore';
    this.crewAboard--;
  }

  private stepTime(occupant: AgentState | CrewMember, pos: number): number {
    return occupant.kind === 'crew' ? this.crewWalkTime(pos) : this.walkTime(occupant, pos);
  }

  private markBlocked(occupant: AgentState | CrewMember): void {
    // Count one interference per episode, not per tick.
    if (!occupant.blocked) {
      occupant.blocked = true;
      this.stallEvents++;
    }
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
    const inTheWay = this.blockedSeats(seat.row, seat.side, seat.depth);
    const blocked = inTheWay.map((s) => s.depth);
    agent.displaced = inTheWay;

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

    // A lift out of an aisle chair is not a slower version of sitting down; it
    // is a different operation, measured in minutes, and it is the reason the
    // whole preboarding policy exists.
    if (p.assistance === 'aisle-chair') {
      this.crewTransfers++;
      return this.rng.triangular(this.params.aisleChairTransferTime);
    }

    let t = this.params.baseSeatingTime;
    if (p.isChild) t += this.params.childSeatingExtra;
    t *= this.assistFactor(p.assistance);
    return t;
  }

  /** Seated passengers between this seat and the aisle. */
  private blockedSeats(row: number, side: string, depth: number): Seat[] {
    const seats: Seat[] = [];
    for (const seat of this.cabin.seatsByRow[row - 1] ?? []) {
      if (seat.side !== side || seat.depth >= depth) continue;
      if (this.occupied.has(`${seat.row}:${seat.letter}`)) seats.push(seat);
    }
    return seats;
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
    // The lift is done; the escorts turn round and head for the door.
    if (agent.passenger.assistance === 'aisle-chair') this.releaseCrew(agent.passenger.id);
    agent.state = 'seated';
    agent.displaced = [];
    agent.pos = -1;
    agent.blocked = false;
    this.seatedCount++;
  }

  /** How many passengers boarded with each kind of assistance. */
  private countAssistance(): Record<AssistanceKind, number> {
    const counts = { none: 0 } as Record<AssistanceKind, number>;
    for (const kind of ASSISTANCE_KINDS) counts[kind] = 0;
    for (const agent of this.agents) counts[agent.passenger.assistance]++;
    return counts;
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
      assistance: a.passenger.assistance,
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
      assistanceCounts: this.countAssistance(),
      crewAboardSeconds: this.crewAboardSeconds,
      crewTransfers: this.crewTransfers,
      crewPassEvents: this.crewPassEvents,
      crewClearSeconds:
        this.allSeatedAt === null || this.crewAshoreAt === null
          ? 0
          : Math.max(0, this.crewAshoreAt - this.allSeatedAt),
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
