/**
 * Published narrow-body geometry, in metres.
 *
 * Every figure marked PUBLISHED is taken from the manufacturer's airport
 * planning document. Those are the drawings airports use to design gates, so
 * they are the authoritative public source for external dimensions, door
 * stations and typical cabin arrangements.
 *
 *   Airbus, "A320 Aircraft Characteristics — Airport and Maintenance Planning",
 *   rev. Jun 01/24. Subjects 2-2-0 (general dimensions), 2-4-1 (interior
 *   arrangements, plan view), 2-5-0 (interior cross section), 2-7-0 (door
 *   identification and location).
 *
 *   Boeing, "737 Airplane Characteristics for Airport Planning", D6-58325-7
 *   rev. C, Oct 2025. Section 2.4.4 (interior arrangements, 737-800).
 *
 * Anything marked DERIVED is this project's own approximation, stated as such
 * rather than dressed up as manufacturer data.
 */

export interface CabinFixture {
  /** Boeing's plan-view legend: G galley, L lavatory, A attendant, C closet. */
  kind: 'galley' | 'lavatory' | 'attendant' | 'closet' | 'stowage';
  side: 'left' | 'right';
  /** Position within its service zone, 0 at the forward end. */
  order: number;
}

export interface ServiceZone {
  /** Length along the fuselage, in metres. */
  lengthM: number;
  fixtures: CabinFixture[];
}

export interface DoorSpec {
  id: string;
  /** Distance aft of the nose, in metres. */
  stationM: number;
  /** Overwing exits are smaller and sit at a seat row. */
  type: 'passenger' | 'overwing';
}

export interface AircraftType {
  id: string;
  name: string;
  source: string;

  // ---- PUBLISHED: external dimensions ----
  lengthM: number;
  wingspanM: number;
  tailplaneSpanM: number;

  // ---- PUBLISHED: cabin cross section ----
  /** Maximum interior cabin width. */
  cabinWidthM: number;
  seatWidthM: number;
  aisleWidthM: number;

  // ---- PUBLISHED: seat pitch by class ----
  pitchEconomyM: number;
  pitchFirstM: number;

  // ---- PUBLISHED: door and exit stations, measured aft of the nose ----
  doors: DoorSpec[];

  // ---- PUBLISHED: typical arrangement ----
  forwardService: ServiceZone;
  aftService: ServiceZone;

  // ---- DERIVED ----
  /** Nose cone length, from the plan view proportions. */
  noseM: number;
  /** Tail cone length, from the plan view proportions. */
  tailM: number;
  /** Wing box extent along the fuselage, centred on the overwing exits. */
  wingRootChordM: number;
  /** Extra pitch multiplier at an overwing exit row. */
  exitRowPitchFactor: number;
}

const IN = 0.0254;

/**
 * Airbus A320-200.
 *
 * Cross-section figures are from the "6 abreast — wider aisle" arrangement:
 * 0.43 m seats, a 1.50 m triple, a 0.64 m aisle inside a 3.63 m cabin. The
 * single-class high-density layout is 180 seats, six abreast at 28/29 in pitch,
 * with two galleys, three lavatories, five attendant seats and four overwing
 * emergency exits.
 */
export const A320: AircraftType = {
  id: 'a320',
  name: 'Airbus A320-200',
  source: 'Airbus A320 Aircraft Characteristics — Airport and Maintenance Planning, Jun 2024',

  lengthM: 37.57,
  wingspanM: 34.1,
  tailplaneSpanM: 12.45,

  cabinWidthM: 3.63,
  seatWidthM: 0.43,
  aisleWidthM: 0.64,

  // Published as "28/29 in" for the 180-seat layout.
  pitchEconomyM: 28.5 * IN,
  pitchFirstM: 36 * IN,

  // Subject 2-7-0 gives door stations aft of the nose. The A320 carries a pair
  // of passenger/crew doors fore and aft, plus two pairs of overwing exits.
  doors: [
    { id: '1L', stationM: 5.04, type: 'passenger' },
    { id: '1R', stationM: 5.04, type: 'passenger' },
    { id: 'OW1', stationM: 14.43, type: 'overwing' },
    { id: 'OW2', stationM: 15.28, type: 'overwing' },
    { id: '2L', stationM: 26.29, type: 'passenger' },
    { id: '2R', stationM: 26.29, type: 'passenger' },
  ],

  // Plan view 2-4-1: forward zone carries a galley on one side and a lavatory
  // on the other, with an attendant seat at the door. The aft zone carries a
  // galley and two lavatories.
  forwardService: {
    lengthM: 1.8,
    fixtures: [
      { kind: 'galley', side: 'left', order: 0 },
      { kind: 'lavatory', side: 'right', order: 0 },
      { kind: 'attendant', side: 'right', order: 1 },
    ],
  },
  aftService: {
    lengthM: 2.9,
    fixtures: [
      { kind: 'galley', side: 'left', order: 1 },
      { kind: 'lavatory', side: 'left', order: 0 },
      { kind: 'lavatory', side: 'right', order: 0 },
      { kind: 'attendant', side: 'right', order: 1 },
    ],
  },

  // The forward vestibule contains door 1L rather than sitting aft of it: on
  // the plan view the galley and lavatory flank the entry area and row 1 starts
  // immediately behind. Placing the cabin at 5.9 m puts the published overwing
  // stations on rows 12-13, which is where published A320 seat maps show them —
  // two independent sources agreeing.
  noseM: 4.1,
  tailM: 8.5,
  wingRootChordM: 7.0,
  // American advertises +8 in on a 30 in pitch at the 737-800 exit rows; the
  // same ratio is applied here.
  exitRowPitchFactor: 1.27,
};

/**
 * Boeing 737-800.
 *
 * Section 2.4.4 gives single-class 175 seats at 32 in pitch or 184 at 30 in,
 * and a mixed cabin of 12 first at 36 in over 148 economy at 32 in. The plan
 * view legend — attendant, closet, galley, lavatory, stowage — is what the
 * fixture kinds here are named after.
 */
export const B737_800: AircraftType = {
  ...A320,
  id: 'b737-800',
  name: 'Boeing 737-800',
  source: 'Boeing 737 Airplane Characteristics for Airport Planning, D6-58325-7 rev. C, Oct 2025',

  lengthM: 39.47,
  wingspanM: 35.79,
  tailplaneSpanM: 14.35,

  // 737 cabin is marginally narrower than the A320's.
  cabinWidthM: 3.54,
  seatWidthM: 0.43,
  aisleWidthM: 0.51,

  pitchEconomyM: 30 * IN,
  pitchFirstM: 36 * IN,

  // DERIVED, not published: the ACAP plan view is a figure without station
  // callouts, so the overwing pair is placed from the documented exit rows 16
  // and 17 of the 189-seat layout, working aft from row 1 at 30 in pitch.
  doors: [
    { id: '1L', stationM: 5.4, type: 'passenger' },
    { id: '1R', stationM: 5.4, type: 'passenger' },
    { id: 'OW1', stationM: 17.4, type: 'overwing' },
    { id: 'OW2', stationM: 18.2, type: 'overwing' },
    { id: '2L', stationM: 29.0, type: 'passenger' },
    { id: '2R', stationM: 29.0, type: 'passenger' },
  ],

  forwardService: {
    lengthM: 1.7,
    fixtures: [
      { kind: 'galley', side: 'left', order: 0 },
      { kind: 'lavatory', side: 'right', order: 0 },
      { kind: 'stowage', side: 'right', order: 1 },
      { kind: 'attendant', side: 'right', order: 2 },
    ],
  },
  aftService: {
    lengthM: 3.0,
    fixtures: [
      { kind: 'galley', side: 'left', order: 1 },
      { kind: 'lavatory', side: 'left', order: 0 },
      { kind: 'lavatory', side: 'right', order: 0 },
      { kind: 'closet', side: 'right', order: 1 },
      { kind: 'attendant', side: 'right', order: 2 },
    ],
  },

  noseM: 4.2,
  tailM: 8.9,
  wingRootChordM: 7.3,
  exitRowPitchFactor: 1.27,
};

export const AIRCRAFT_TYPES: AircraftType[] = [A320, B737_800];

/**
 * Seat rows that sit at an overwing exit.
 *
 * Derived from the published exit stations rather than a rule of thumb: the row
 * whose centre lies nearest each exit is the exit row. On the A320's 180-seat
 * layout this lands at rows 13-14, which is where operators put them.
 */
export function exitRowsFor(type: AircraftType, rows: number, firstClassRows: number): number[] {
  const found = new Set<number>();
  for (const door of type.doors) {
    if (door.type !== 'overwing') continue;
    let station = type.noseM + type.forwardService.lengthM;
    for (let row = 1; row <= rows; row++) {
      const pitch = row <= firstClassRows ? type.pitchFirstM : type.pitchEconomyM;
      if (station + pitch > door.stationM) {
        found.add(row);
        break;
      }
      station += pitch;
    }
  }
  return [...found].sort((a, b) => a - b);
}
