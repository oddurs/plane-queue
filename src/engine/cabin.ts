import { A320, AIRCRAFT_TYPES, exitRowsFor, type AircraftType } from './aircraft.ts';
import type { Cabin, CabinConfig, CabinFeatures, Seat, Side } from './types.ts';

/**
 * Narrow-body, single-aisle, single forward door — the configuration used
 * throughout the boarding literature, so results stay comparable to published
 * numbers.
 *
 * Economy is 3-3: A B C | aisle | D E F, so A and F are windows, C and D are
 * aisle seats. First class is 2-2: A B | aisle | E F.
 */

const ECONOMY_LEFT = ['A', 'B', 'C'] as const;
const ECONOMY_RIGHT = ['D', 'E', 'F'] as const;
const FIRST_LEFT = ['A', 'B'] as const;
const FIRST_RIGHT = ['E', 'F'] as const;

/**
 * Seats are listed aisle-outward on each side, so a seat's index within its
 * half-row *is* its distance from the aisle.
 */
function halfRow(
  row: number,
  side: Side,
  letters: readonly string[],
  cabinClass: Seat['cabinClass'],
): Seat[] {
  // Left-side letters run window-to-aisle; reverse them so index 0 is the aisle.
  const aisleOutward = side === 'left' ? [...letters].reverse() : [...letters];
  return aisleOutward.map((letter, depth) => ({
    row,
    letter,
    side,
    depth,
    cabinClass,
  }));
}

/**
 * Lays a cabin out on published aircraft geometry.
 *
 * Row pitch, exit-row placement and the service zones all come from the
 * manufacturer's airport-planning document rather than a rule of thumb, so the
 * drawing is to scale and the walking time charged for each row matches the
 * distance actually covered.
 */
export function buildCabin(config: CabinConfig): Cabin {
  const type = AIRCRAFT_TYPES.find((t) => t.id === config.typeId) ?? A320;
  const seatsByRow: Seat[][] = [];

  for (let row = 1; row <= config.rows; row++) {
    const isFirst = row <= config.firstClassRows;
    const left = isFirst ? FIRST_LEFT : ECONOMY_LEFT;
    const right = isFirst ? FIRST_RIGHT : ECONOMY_RIGHT;
    const cabinClass = isFirst ? 'first' : 'economy';
    seatsByRow.push([
      ...halfRow(row, 'left', left, cabinClass),
      ...halfRow(row, 'right', right, cabinClass),
    ]);
  }

  const exitRows = exitRowsFor(type, config.rows, config.firstClassRows);
  const exits = new Set(exitRows);

  const rowPitchM: number[] = [];
  for (let row = 1; row <= config.rows; row++) {
    const base = row <= config.firstClassRows ? type.pitchFirstM : type.pitchEconomyM;
    rowPitchM.push(exits.has(row) ? base * type.exitRowPitchFactor : base);
  }
  // Relative to standard economy pitch, which is what the walk time is tuned on.
  const rowPitch = rowPitchM.map((m) => m / type.pitchEconomyM);

  const features: CabinFeatures = {
    exitRows,
    // The wing box straddles the overwing exits. Its chord is published; where
    // it starts relative to the exits is this project's approximation.
    wingRows: wingRowsFor(type, rowPitchM, exitRows, config.rows),
  };

  return {
    config,
    seats: seatsByRow.flat(),
    seatsByRow,
    features,
    type,
    rowPitch,
    rowPitchM,
  };
}

/** Rows the wing box passes under, centred on the overwing exits. */
function wingRowsFor(
  type: AircraftType,
  rowPitchM: number[],
  exitRows: number[],
  rows: number,
): [number, number] {
  if (exitRows.length === 0) return [Math.max(1, Math.round(rows * 0.35)), Math.round(rows * 0.6)];
  const centre = exitRows[Math.floor(exitRows.length / 2)] as number;
  const meanPitch = rowPitchM.reduce((s, p) => s + p, 0) / (rowPitchM.length || 1);
  const halfSpanRows = Math.max(2, Math.round(type.wingRootChordM / meanPitch / 2));
  return [Math.max(1, centre - halfSpanRows), Math.min(rows, centre + halfSpanRows)];
}

export function seatLabel(seat: Seat): string {
  return `${seat.row}${seat.letter}`;
}

/** Deepest seat index on a side — 2 in economy, 1 in a 2-2 first-class row. */
export function maxDepth(cabin: Cabin, row: number): number {
  return row <= cabin.config.firstClassRows ? 1 : 2;
}
