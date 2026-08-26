import type { PassengerWait } from './types.ts';

/**
 * Who pays for the speed.
 *
 * Every other measure in this app is a total or an average: how long boarding
 * took, how much waiting there was in aggregate. But a boarding strategy is a
 * distributive policy. Back-to-front is quick for row 30 and punishing for
 * row 1, because the people at the front board last and stand through the whole
 * process. Premium-to-coach sells the good outcome outright. Steffen's optimum
 * spreads the wait evenly but demands that the gate sort everybody by name.
 *
 * The simulation already records what every individual passenger endured and
 * then reduces it to a mean. This keeps the distribution.
 *
 * The measure throughout is *imposed delay* — time spent standing still because
 * of somebody else — rather than total time aboard. Time aboard is dominated by
 * how far down the cabin you sit, which is geometry rather than policy: row 30
 * walks further than row 2 under every strategy ever proposed. Blocked time is
 * the part a strategy actually allocates.
 */

export interface Band {
  label: string;
  meanWait: number;
  count: number;
}

export interface Equity {
  /** Mean imposed delay for the passengers seated in each row, indexed [row - 1]. */
  byRow: number[];
  /** Forward, middle and rear thirds of the cabin. */
  byZone: Band[];
  /** Window, middle and aisle seats. */
  byColumn: Band[];
  /** Travelling alone, in a party, or needing assistance. */
  byCohort: Band[];

  median: number;
  p90: number;
  /** Mean wait of the worst-served tenth. */
  worstTenth: number;
  /** Mean wait of the best-served tenth. */
  bestTenth: number;
  /**
   * Share of all imposed delay borne by the worst-served tenth, 0 to 1.
   *
   * Preferred to a worst/best ratio, which divides by a number that approaches
   * zero under the fastest strategies and blows up to meaningless multiples.
   * A tenth of the passengers bearing a tenth of the delay gives 0.1.
   */
  worstTenthShare: number;
  /**
   * Gini coefficient of waiting time, 0 (everyone waits the same) to 1 (one
   * passenger absorbs all of it). Borrowed from income distribution because the
   * question is the same shape: how concentrated is the burden?
   */
  gini: number;
}

const EMPTY: Equity = {
  byRow: [],
  byZone: [],
  byColumn: [],
  byCohort: [],
  median: 0,
  p90: 0,
  worstTenth: 0,
  bestTenth: 0,
  worstTenthShare: 0,
  gini: 0,
};

/**
 * Gini coefficient over a set of non-negative values.
 *
 * Uses the sorted form: with values ascending, G = (2·Σ i·xᵢ − (n+1)·Σ xᵢ) /
 * (n · Σ xᵢ). Equal values give 0; all the weight on one gives (n−1)/n, which
 * approaches 1 as the population grows.
 */
export function gini(values: number[]): number {
  const sorted = [...values].filter((v) => v >= 0).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;

  const total = sorted.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;

  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * (sorted[i] as number);
  return (2 * weighted - (n + 1) * total) / (n * total);
}

function band(label: string, waits: number[]): Band {
  const count = waits.length;
  return {
    label,
    count,
    meanWait: count === 0 ? 0 : waits.reduce((s, v) => s + v, 0) / count,
  };
}

/** Fraction of the total borne by the highest tenth. */
function share(sorted: number[]): number {
  const total = sorted.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  const take = Math.max(1, Math.round(sorted.length / 10));
  const top = sorted.slice(-take).reduce((s, v) => s + v, 0);
  return top / total;
}

/** Mean of the lowest or highest tenth. */
function tail(sorted: number[], end: 'low' | 'high'): number {
  if (sorted.length === 0) return 0;
  const take = Math.max(1, Math.round(sorted.length / 10));
  const slice = end === 'low' ? sorted.slice(0, take) : sorted.slice(-take);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

export function computeEquity(waits: PassengerWait[], rows: number): Equity {
  if (waits.length === 0) return EMPTY;

  const seconds = waits.map((w) => w.blocked);
  const sorted = [...seconds].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;

  const rowTotals = new Array<number>(rows).fill(0);
  const rowCounts = new Array<number>(rows).fill(0);
  for (const w of waits) {
    const i = w.row - 1;
    if (i < 0 || i >= rows) continue;
    rowTotals[i] = (rowTotals[i] as number) + w.blocked;
    rowCounts[i] = (rowCounts[i] as number) + 1;
  }
  const byRow = rowTotals.map((total, i) => {
    const n = rowCounts[i] as number;
    return n === 0 ? 0 : total / n;
  });

  const third = Math.max(1, Math.ceil(rows / 3));
  const inZone = (from: number, to: number): number[] =>
    waits.filter((w) => w.row >= from && w.row <= to).map((w) => w.blocked);

  // Depth is 0 at the aisle and 2 at the window; first-class rows top out at 1.
  const atDepth = (test: (w: PassengerWait) => boolean): number[] =>
    waits.filter(test).map((w) => w.blocked);

  return {
    byRow,
    byZone: [
      band('Forward', inZone(1, third)),
      band('Middle', inZone(third + 1, third * 2)),
      band('Rear', inZone(third * 2 + 1, rows)),
    ],
    byColumn: [
      band('Window', atDepth((w) => w.depth === w.maxDepth)),
      band('Middle', atDepth((w) => w.depth > 0 && w.depth < w.maxDepth)),
      band('Aisle', atDepth((w) => w.depth === 0)),
    ],
    // Assistance is split out by kind rather than lumped together: a passenger
    // with a cane and one being lifted out of an aisle chair are having very
    // different mornings, and averaging them hides the one worth seeing.
    byCohort: [
      band('Alone', atDepth((w) => w.partyId === null && !w.needsAssistance)),
      band('In a party', atDepth((w) => w.partyId !== null && !w.needsAssistance)),
      band('Aisle chair', atDepth((w) => w.assistance === 'aisle-chair')),
      band('Own chair to door', atDepth((w) => w.assistance === 'own-wheelchair')),
      band('Reduced mobility', atDepth((w) => w.assistance === 'reduced-mobility')),
      band('Escorted minor', atDepth((w) => w.assistance === 'minor')),
    ].filter((b) => b.count > 0),
    median: at(0.5),
    p90: at(0.9),
    worstTenth: tail(sorted, 'high'),
    bestTenth: tail(sorted, 'low'),
    worstTenthShare: share(sorted),
    gini: gini(seconds),
  };
}

/**
 * Plain-language reading of a distribution.
 *
 * Deliberately avoids calling any arrangement "fair" or "unfair" — it reports
 * the spread and who sits at each end, and leaves the judgement to the reader.
 */
export function describeEquity(equity: Equity): string {
  const zones = [...equity.byZone].sort((a, b) => b.meanWait - a.meanWait);
  const worst = zones[0];
  const best = zones.at(-1);
  if (!worst || !best) return '';

  const spread =
    equity.gini < 0.2
      ? 'Delay is spread fairly evenly'
      : equity.gini < 0.35
        ? 'Delay falls unevenly'
        : 'Delay is concentrated on a minority';

  return (
    `${spread} — the worst-served tenth of passengers absorb ` +
    `${Math.round(equity.worstTenthShare * 100)}% of all the waiting (Gini ` +
    `${equity.gini.toFixed(2)}). ${worst.label} seats average ` +
    `${Math.round(worst.meanWait)}s of imposed delay against ` +
    `${Math.round(best.meanWait)}s ${best.label === 'Forward' ? 'forward' : `for the ${best.label.toLowerCase()}`}.`
  );
}
