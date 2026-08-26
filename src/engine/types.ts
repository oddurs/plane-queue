import type { AircraftType } from './aircraft.ts';
import type { PolicyWeights } from './policy.ts';

/**
 * Core domain types for the boarding simulation.
 *
 * The engine is pure TypeScript with no DOM dependencies so that the animated
 * run and the headless Monte Carlo batch execute the exact same code path.
 */

export type CabinClass = 'first' | 'economy';

/** Which side of the single aisle a seat is on. */
export type Side = 'left' | 'right';

export interface Seat {
  row: number;
  letter: string;
  side: Side;
  /**
   * Distance from the aisle: 0 = aisle seat, 1 = middle, 2 = window.
   * Seat interference is entirely a function of depth, so it is precomputed.
   */
  depth: number;
  cabinClass: CabinClass;
}

export interface CabinConfig {
  /** Published aircraft geometry this cabin is laid out on. */
  typeId?: string;
  /** Total seat rows, numbered 1..rows from the front. */
  rows: number;
  /** Leading rows laid out 2-2 instead of 3-3. */
  firstClassRows: number;
  /** Overhead bag slots available at each row. */
  binSlotsPerRow: number;
}

/**
 * Fixtures that are not seats.
 *
 * Real narrow-bodies are not an unbroken field of seat rows: there is a galley
 * and lavatory ahead of row 1, overwing exits partway down with extra pitch,
 * and a galley plus lavatories behind the last row. Modelling them makes the
 * diagram an aircraft rather than a spreadsheet, and the exit-row pitch is a
 * real effect on how long it takes to walk that stretch of aisle.
 */
export interface CabinFeatures {
  /** Rows aligned with an overwing exit; these have extra seat pitch. */
  exitRows: number[];
  /** Rows spanned by the wing box, drawn behind the cabin. */
  wingRows: [number, number];
}

export interface Cabin {
  config: CabinConfig;
  seats: Seat[];
  /** seatsByRow[row - 1] — every seat in that row, both sides. */
  seatsByRow: Seat[][];
  features: CabinFeatures;
  /** The published geometry this cabin is drawn and timed against. */
  type: AircraftType;
  /**
   * Relative pitch of each row, indexed [row - 1]. 1 is standard; first-class
   * and exit rows are larger. Walking past a row costs time in proportion.
   */
  rowPitch: number[];
  /** Absolute pitch of each row in metres, for drawing to scale. */
  rowPitchM: number[];
}

/**
 * The kinds of boarding assistance an airline actually distinguishes.
 *
 * They are not interchangeable, and the difference is not politeness — it is
 * how much of the aisle each one occupies and for how long. A passenger with a
 * cane preboards and walks aboard slowly. A passenger who uses an aisle chair
 * is carried aboard by crew who then have to walk back out against the boarding
 * flow, which is the single most disruptive thing that happens in a jetbridge
 * and was previously modelled as "a bit slower".
 */
export type AssistanceKind =
  /** No assistance requested. */
  | 'none'
  /**
   * Transferred to a narrow aisle chair at the door and taken to the seat by
   * crew, who lift the passenger across and then leave the aircraft.
   */
  | 'aisle-chair'
  /**
   * Uses their own wheelchair as far as the aircraft door, then walks or is
   * steadied to the seat. No aisle chair, no lift, no crew walking back out.
   */
  | 'own-wheelchair'
  /** Cane, walker, or simply slow on their feet. Preboards; boards unaided. */
  | 'reduced-mobility'
  /** Unaccompanied minor or an adult with an infant in arms, escorted by crew. */
  | 'minor';

/** Every assistance kind that is not `none`, in the order the UI lists them. */
export const ASSISTANCE_KINDS: Exclude<AssistanceKind, 'none'>[] = [
  'aisle-chair',
  'own-wheelchair',
  'reduced-mobility',
  'minor',
];

/**
 * How the assisted share of a cabin divides between the kinds.
 *
 * Held as relative weights rather than fractions that must sum to one, so a
 * slider can be dragged without silently rescaling its neighbours.
 */
export type AssistanceMix = Record<Exclude<AssistanceKind, 'none'>, number>;

export interface Passenger {
  id: number;
  seat: Seat;
  /** Carry-on items needing overhead space. */
  bags: number;
  /** Members of a travelling party share a partyId; solo travellers get null. */
  partyId: number | null;
  isChild: boolean;
  /** What kind of help this passenger boards with, if any. */
  assistance: AssistanceKind;
  /** `assistance !== 'none'`, kept as a field because so much code asks it. */
  needsAssistance: boolean;
  /** Multiplier on walking and seating time; >1 is slower. */
  slowFactor: number;
}

/** A triangular distribution, as used by Schultz (2018) for stow times. */
export interface Triangular {
  min: number;
  mode: number;
  max: number;
}

export interface SimParams {
  /** Simulation timestep in seconds. */
  tick: number;
  /** Seconds to walk past one row of seats. */
  walkTimePerRow: number;
  /** Stow time for the first bag; each further bag adds `stowTimePerExtraBag`. */
  stowTimeFirstBag: Triangular;
  stowTimePerExtraBag: Triangular;
  /** Time cost of one seated passenger standing to let someone past. */
  shuffleTimePerBlocker: Triangular;
  /** Extra seconds of aisle blockage per row travelled to find a free bin. */
  binSearchTimePerRow: number;
  /**
   * Extra seconds to stow when someone in an adjacent row is also at the bins.
   *
   * Two people cannot comfortably wrestle roll-aboards into neighbouring bins
   * at once. This is the physical reason Steffen's optimum spaces passengers
   * two rows apart — "the separation between adjacent passengers provides some
   * space for each passenger to manipulate their luggage into the bins."
   */
  adjacentStowPenalty: number;
  /** How far from their seat a passenger will hunt for overhead space. */
  binSearchRadius: number;
  /**
   * Walk/seat time multiplier for a passenger who boards on their own feet with
   * help — a cane, a walker, or their own wheelchair as far as the door.
   */
  assistanceSlowFactor: number;
  /** Walk time multiplier for an aisle chair being pushed down the aisle. */
  aisleChairSlowFactor: number;
  /** Walk/seat time multiplier for an escorted minor. */
  minorSlowFactor: number;
  /**
   * Seconds a passenger arriving in their own wheelchair spends at the door,
   * getting out of it before walking to the seat.
   *
   * It happens in the doorway, so it holds up the whole queue behind them —
   * which is what makes it a different thing from simply walking slowly, and
   * the reason the two are worth telling apart at all.
   */
  doorTransferTime: Triangular;
  /** Crew who board with each aisle-chair passenger and leave once seated. */
  escortsPerAisleChair: number;
  /**
   * Seconds to lift a passenger from the aisle chair into the seat.
   *
   * Far longer than sitting down unaided, and it blocks the aisle cell beside
   * the row plus the cells the crew are standing in for the whole of it.
   */
  aisleChairTransferTime: Triangular;
  /**
   * Seconds lost by each of a boarding passenger and a departing crew member
   * when they squeeze past one another in the aisle.
   *
   * They do get past — an aisle is not quite single file if one person presses
   * into a row — but both are delayed, and that delay is the real cost of
   * sending crew back out through an incoming stream.
   */
  crewPassTime: number;
  /** Seconds to drop into a seat once the way is clear. */
  baseSeatingTime: number;
  /** Extra seconds seating a child. */
  childSeatingExtra: number;
  /**
   * Whether the gate takes bags once the cabin cannot hold them.
   *
   * When the bins are going to run out, agents stop the last boarding groups
   * and tag their bags. Those passengers then board with nothing to stow, which
   * is why a full flight does not degrade without limit.
   */
  gateCheckWhenFull: boolean;
  /**
   * Stow time multiplier for a passenger whose travelling companion is already
   * at the bins. One adult lifts for the family rather than each member
   * repeating the operation.
   */
  partyStowShare: number;
  /** Hard cap so a pathological config cannot hang the UI. */
  maxSimSeconds: number;
}

export interface PopulationConfig {
  /** Fraction of seats filled, 0..1. */
  loadFactor: number;
  /** Mean carry-on items per passenger. */
  meanBags: number;
  /** Fraction of passengers travelling in a party of 2+. */
  partyFraction: number;
  /** Fraction of passengers needing assistance boarding. */
  assistanceFraction: number;
  /**
   * How that fraction divides between the kinds of assistance.
   *
   * Optional because scenarios are persisted — a run pinned to the bench before
   * this existed still has to restore and re-run. Absent means the default mix.
   */
  assistanceMix?: AssistanceMix;
  /** Fraction of party members that are children. */
  childFraction: number;
  /**
   * Spread of individual walking pace, as the sigma of a unit-mean log-normal.
   *
   * The cellular-automaton literature models walking speed varying with age,
   * height and build rather than treating everyone as identical. 0 makes every
   * passenger move at the same pace; 0.25 gives a realistic mix of brisk and
   * dawdling without changing the average.
   */
  speedSpread: number;
}

export type StrategyId =
  | 'random'
  | 'back-to-front'
  | 'front-to-back'
  | 'outside-in'
  | 'reverse-pyramid'
  | 'steffen-perfect'
  | 'steffen-modified'
  | 'premium-first'
  /**
   * A policy found by the optimizer, driven by `BoardingConfig.customWeights`.
   * Deliberately absent from the named-strategy list so it never appears in
   * comparisons unless something explicitly asks for it.
   */
  | 'custom';

export interface BoardingConfig {
  strategy: StrategyId;
  /** Blocks used by back-to-front / front-to-back. */
  blocks: number;
  /**
   * Gate order enforcement. `null` means the strategy order is followed
   * exactly. A number splits the order into that many release groups and
   * shuffles within each — modelling passengers queueing arbitrarily inside
   * their called group. 1 group therefore degenerates to random boarding.
   */
  releaseGroups: number | null;
  /** Board passengers needing assistance (and their party) first. */
  preboardAssistance: boolean;
  /** Pull party members together in the queue, overriding strategy order. */
  familiesBoardTogether: boolean;
  /** Seat-scoring weights used when `strategy` is 'custom'. */
  customWeights?: PolicyWeights;
}

export type PassengerState =
  | 'queued'
  | 'walking'
  | 'stowing'
  | 'shuffling'
  | 'seated';

/** Live per-passenger simulation state, kept parallel to the Passenger list. */
/**
 * Anything standing in an aisle cell.
 *
 * The aisle used to hold passengers only and ran strictly one way. Crew who
 * bring an aisle chair aboard have to walk back out through people still
 * boarding, so a cell can now hold either, moving either way.
 */
export interface AisleOccupant {
  /** Aisle cell: 0 = doorway, 1..rows = alongside that row. -1 = not aboard. */
  pos: number;
  /**
   * Cell this occupant is stepping out of, and how long the step takes. The
   * renderer interpolates between the two so people glide rather than
   * teleporting from row to row.
   */
  fromPos: number;
  stepDuration: number;
  /** Countdown to the next action, in seconds. */
  timer: number;
  /** True while this occupant is held up by someone in the way. */
  blocked: boolean;
}

/** Where a crew escort is up to. */
export type CrewState =
  /** At the door, waiting to follow their passenger aboard. */
  | 'waiting'
  /** Walking aft behind the aisle chair. */
  | 'escorting'
  /** Standing by the row while the passenger is lifted into the seat. */
  | 'transferring'
  /** Walking forward to the door, against the boarding flow. */
  | 'leaving'
  /** Off the aircraft. */
  | 'ashore';

/**
 * A crew member escorting an aisle-chair passenger.
 *
 * They are not passengers: they have no seat, they never appear in the manifest
 * or the equity figures, and boarding is not finished until they are back off
 * the aircraft.
 */
export interface CrewMember extends AisleOccupant {
  kind: 'crew';
  id: number;
  /** Passenger id this escort is aboard for. */
  clientId: number;
  state: CrewState;
  /** +1 walking aft to the seat, -1 walking forward to the door. */
  heading: 1 | -1;
  /**
   * Which lane they are standing in.
   *
   * Turning round and crossing into the outbound lane are two different things:
   * an escort whose colleague is already walking out through the same stretch
   * of aisle has to wait its turn, and until it does it is still in everybody's
   * way in the boarding stream.
   */
  lane: 'aisle' | 'exit';
  /** Aisle cell this escort works from during the transfer. */
  station: number;
  /** Seconds spent aboard, door to door. */
  aboardTime: number;
}

export interface AgentState extends AisleOccupant {
  kind: 'passenger';
  passenger: Passenger;
  state: PassengerState;
  /** Queue index; determines boarding order. */
  order: number;
  /** Release group index, for colouring and gating. */
  group: number;
  /** Seconds spent aboard but not yet seated. */
  aisleTime: number;
  /** Seconds spent standing still because someone ahead was in the way. */
  blockedTime: number;
  /** Rows travelled from the seat row to find overhead space. */
  binOffset: number;
  /** Bags taken at the gate, so never stowed in the cabin. */
  gateCheckedBags: number;
  /**
   * Seats whose occupants are on their feet to let this passenger past.
   *
   * The simulation has always charged for this — it is the seat interference
   * the whole literature is about — but only as time. Naming the seats lets the
   * drawing show what the delay actually is: two people standing in the aisle.
   */
  displaced: Seat[];
}

export interface SeatInterferenceCounts {
  /** Aisle seat occupied, passenger heading for the middle. */
  type1: number;
  /** Aisle seat occupied, passenger heading for the window. */
  type2: number;
  /** Middle seat occupied, passenger heading for the window. */
  type3: number;
  /** Both aisle and middle occupied, passenger heading for the window. */
  type4: number;
}

/**
 * One passenger's wait, kept with enough of their identity to ask who bore it.
 *
 * The run already knows all of this; reducing it to a mean was throwing away
 * the distribution.
 */
export interface PassengerWait {
  row: number;
  /** 0 at the aisle, up to `maxDepth` at the window. */
  depth: number;
  maxDepth: number;
  partyId: number | null;
  needsAssistance: boolean;
  /** Which kind of help, so the equity bands can separate them. */
  assistance: AssistanceKind;
  /** Seconds aboard but not yet seated: transit plus imposed delay. */
  seconds: number;
  /**
   * Seconds spent standing still because someone else was in the way.
   *
   * This, not time aboard, is what a boarding policy actually distributes. A
   * passenger in row 30 will always walk further than one in row 2 — that is
   * the geometry of the aircraft, not a choice anyone made. What the strategy
   * decides is how long each of them stands waiting on other people.
   */
  blocked: number;
}

export interface Metrics {
  /**
   * Whether every passenger actually sat down.
   *
   * `maxSimSeconds` is a safety net against a pathological configuration
   * hanging the UI, not a modelling choice. A run that hits it stops with people
   * still standing, and its `totalTime` is the cap rather than a boarding time.
   * Averaging those into a median silently pins every strategy to the same
   * number and makes them all look identical, so nothing may present an
   * incomplete run as a measurement.
   */
  complete: boolean;
  /** Seconds from the first passenger boarding to the last being seated. */
  totalTime: number;
  /**
   * Distinct episodes of a passenger being stopped in the aisle.
   *
   * Deliberately *not* called an aisle-interference count. Steffen & Hotchkiss
   * count roughly one interference per passenger — the event of being held up
   * by someone stowing. This counts every time anyone stops moving, which on a
   * full narrow-body runs to thousands. It is useful for comparing runs, and
   * misleading if read as the published quantity.
   */
  stallEvents: number;
  seatInterferences: SeatInterferenceCounts;
  /** Total seat interferences across all four types. */
  seatInterferenceTotal: number;
  /** Passengers who had to use a bin away from their own row. */
  binSearches: number;
  /** Bags taken at the gate because the cabin could not hold them. */
  gateChecked: number;
  /** How many passengers boarded with each kind of assistance. */
  assistanceCounts: Record<AssistanceKind, number>;
  /** Crew-seconds spent aboard escorting aisle-chair passengers, door to door. */
  crewAboardSeconds: number;
  /** Aisle-chair transfers performed. */
  crewTransfers: number;
  /**
   * Times a departing crew member and a boarding passenger squeezed past each
   * other. The cost of sending crew back out through an incoming stream, which
   * is invisible in any model where the aisle only runs one way.
   */
  crewPassEvents: number;
  /**
   * Simulated seconds from the last passenger sitting down to the last crew
   * member stepping off. Boarding is not finished until the aisle is empty.
   */
  crewClearSeconds: number;
  /** Seconds each passenger spent standing in the aisle. */
  aisleTimes: number[];
  /** The same waits, attributed to who endured them. */
  waits: PassengerWait[];
  meanAisleTime: number;
  medianAisleTime: number;
  /**
   * Total passenger-seconds lost to being stuck behind someone else.
   *
   * More informative than a raw count of blocking episodes: it is the actual
   * human cost of a strategy, and it separates methods that block a few people
   * for a long time from those that block many people briefly.
   */
  totalBlockedSeconds: number;
  /** Seated count sampled over time, for the boarding curve. */
  curve: { t: number; seated: number }[];
  congestion: Congestion;
}

/**
 * Where and when the aisle jammed: passenger-seconds spent blocked at each
 * aisle cell, bucketed over time.
 *
 * Covers seat rows only. Time spent waiting at the doorway counts toward
 * `totalBlockedSeconds` but has no row to attribute it to, so the grid sums to
 * slightly less than that total.
 *
 * Worth knowing when reading it: the jam forms *behind* whoever is stowing, so
 * a queue of people heading for the rear shows up as congestion in the forward
 * rows. Back-to-front is front-heavy for exactly that reason.
 */
export interface Congestion {
  rows: number;
  bucketSeconds: number;
  /** Row-major, `rows * buckets` entries: blocked seconds in that cell. */
  data: number[];
  buckets: number;
  /** Largest single-cell value, for scaling the colour ramp. */
  peak: number;
}
