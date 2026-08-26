import { maxDepth } from '../engine/cabin.ts';
import { TYPE, WEIGHT, canvasFont } from '../ui/type.ts';
import type { AgentState, Cabin, Seat } from '../engine/types.ts';
import type { SimSnapshot } from '../engine/sim.ts';

/**
 * Top-down view of the cabin, drawn as an aircraft rather than a spreadsheet.
 *
 * Nose left, tail right, so boarding runs left to right — the same direction as
 * the aisle index in the simulation. The layout follows a real narrow-body:
 * a galley and lavatory ahead of row 1, overwing exits with visibly greater
 * pitch partway down, the wing box behind the cabin, and an aft galley with a
 * pair of lavatories behind the last row.
 *
 * Passenger state is colour-coded so the two interference types the literature
 * cares about are visible as they happen: amber for someone stowing luggage,
 * red for a row shuffling to let a passenger past.
 */

/** Flat, unlit and high-contrast — a technical drawing, not a rendering. */
/**
 * A technical drawing: thin lines, neutral greys, and saturation reserved for
 * passenger state so the eye goes to what is happening rather than to the
 * aircraft it is happening in.
 */
const COLORS = {
  fuselage: '#0d0f12',
  hull: '#4a5560',
  hullSoft: '#2a3038',
  wing: '#14181d',
  wingEdge: '#252b32',
  seatEmpty: '#171b20',
  seatEdge: '#252b32',
  seatBack: '#1e232a',
  seatTaken: '#24483a',
  seatTakenBack: '#1c3a2f',
  firstClass: '#1b222b',
  aisle: '#111418',
  service: '#141821',
  serviceHatch: '#1d232c',
  exit: '#ffc53d',
  bag: '#6f6350',
  head: '#e6e8ea',
  binEmpty: '#161a1f',
  binUsed: '#5c5847',
  binFull: '#ffc53d',
  walking: '#4a9eff',
  stowing: '#ffc53d',
  shuffling: '#ff5f56',
  blocked: '#6b7280',
  text: '#5c626a',
  textBright: '#e6e8ea',
  crew: '#b98cff',
  crewLeaving: '#e0b3ff',
  aisleChair: '#2dd4bf',
} as const;

/** Categorical series palette, saturated enough to hold up on near-black. */
const GROUP_COLORS = [
  '#4a9eff',
  '#3ddc84',
  '#ffc53d',
  '#ff8f4a',
  '#b98cff',
  '#2dd4bf',
  '#ff6f91',
  '#a3e635',
];

/**
 * The smallest drawing scale worth showing, in pixels per metre.
 *
 * Below roughly this, a 0.43 m seat is under 7px and the cabin stops being
 * readable — on a phone the aircraft was rendering at 3.4px per seat. Rather
 * than shrink past legibility the canvas keeps this scale and grows wider than
 * its frame, so a narrow screen pans across the drawing the way you would pan
 * across a blueprint.
 */
const MIN_SCALE = 16;

/** Whether the viewer has asked for less motion. Read once; it rarely changes. */
const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const FIXTURE_LABEL: Record<string, string> = {
  galley: 'G',
  lavatory: 'L',
  attendant: 'A',
  closet: 'C',
  stowage: 'S',
};

export interface Layout {
  /** Left edge and width of each seat row, indexed [row - 1]. */
  rowX: number[];
  rowW: number[];
  seatH: number;
  gap: number;
  originY: number;
  /** Top of the upper seat band, inboard of the sidewall trim. */
  seatTopY: number;
  aisleY: number;
  cabinH: number;
  /** Seat field extents. */
  cabinX0: number;
  cabinX1: number;
  fwdX0: number;
  aftX1: number;
  noseX: number;
  tailX: number;
  top: number;
  bottom: number;
  /** Half-span of the wings, measured out from the fuselage edge. */
  wingSpan: number;
  /** Canvas pixels per metre. */
  scale: number;
  /** Baseline of the jetbridge queue lane. */
  queueY: number;
}

/**
 * Fits the aircraft to the canvas, working in metres throughout.
 *
 * Everything is scaled from the published geometry, so the fuselage carries its
 * real length-to-width ratio, exit rows are as much wider as their extra pitch
 * makes them, and doors land at their documented stations rather than wherever
 * looked right.
 */
/** Length of the drawn aircraft in metres, cabin included. */
function drawnLengthM(cabin: Cabin): number {
  const t = cabin.type;
  const cabinM = cabin.rowPitchM.reduce((sum, p) => sum + p, 0);
  return t.noseM + t.forwardService.lengthM + cabinM + t.aftService.lengthM + t.tailM;
}

/** Station of the door passengers board through, in metres from the nose. */
function boardingDoorM(cabin: Cabin): number | null {
  return cabin.type.doors.find((d) => d.id === '1L')?.stationM ?? null;
}

/** Canvas width needed to draw this cabin at the minimum legible scale. */
export function requiredWidth(cabin: Cabin): number {
  return Math.ceil(drawnLengthM(cabin) * MIN_SCALE + 24);
}

/**
 * Canvas height the drawing needs at a given width.
 *
 * `layout` centres the aircraft in whatever height it is handed and hangs the
 * wings, the row numbers and the jetbridge lane below it, so the frame cannot
 * simply be told to fill its container: too tall and the aeroplane floats in a
 * void with its own statistics a screen away, too short and `queueY` hits its
 * `height - 6` clamp and rides up into the row numbers. The drawing knows how
 * much room it wants, so it says.
 *
 * Only the cabin band scales with the width; everything under it is fixed. With
 * `d` as half the slack, `layout` puts the band at `originY = d - 14` and the
 * queue at `bottom + wingSpan + 64`, and clamps that to `height - 6`. Asking
 * for no clamping at the widest the wings are ever drawn:
 *
 *     cabinH + 2d - 6  >=  (d - 14) + cabinH + 54 + 64
 *                    d  >=  110
 *
 * which is the 220 below.
 */
export function requiredHeight(cabin: Cabin, width: number): number {
  const scale = (width - 24) / drawnLengthM(cabin);
  // The gate sits above the aircraft and has to clear the wings, which reach
  // `wingSpan` up from the cabin band. Every pixel of clearance costs two of
  // height, because the aeroplane is centred in whatever it is given.
  const gate = showsGate(width) ? 52 : 0;
  return Math.ceil(cabin.type.cabinWidthM * scale + 220 + gate);
}



/**
 * Whether there is width to draw the gate rather than a strip of dots.
 *
 * Two cabins racing get half the frame each, and a lounge squeezed into that is
 * worse than the bar it replaces — so below this they keep the compact strip.
 */
function showsGate(width: number): boolean {
  return width >= 880;
}

function layout(cabin: Cabin, width: number, height: number): Layout {
  const t = cabin.type;
  const rows = cabin.config.rows;
  const margin = 12;

  const totalM = drawnLengthM(cabin);

  const byWidth = (width - margin * 2) / totalM;
  // Keep the true beam: the cabin band must also fit the height available.
  const byHeight = (height - 104) / t.cabinWidthM;
  const scale = Math.min(byWidth, byHeight);

  // Cross section, to scale: sidewall clearance, three seats, the aisle, three
  // seats, sidewall clearance. On the A320 that is 0.43 m seats and a 0.64 m
  // aisle inside a 3.63 m cabin, leaving ~0.20 m of trim each side.
  const cabinH = t.cabinWidthM * scale;
  const seatH = t.seatWidthM * scale;
  const gap = t.aisleWidthM * scale;
  const sidewall = Math.max(0, (cabinH - seatH * 6 - gap) / 2);
  const originY = Math.max(26, (height - cabinH) / 2 - 14);
  const seatTopY = originY + sidewall;

  const noseX = margin;
  const fwdX0 = noseX + t.noseM * scale;
  const cabinX0 = fwdX0 + t.forwardService.lengthM * scale;

  const rowX: number[] = [];
  const rowW: number[] = [];
  let x = cabinX0;
  for (let i = 0; i < rows; i++) {
    const w = (cabin.rowPitchM[i] ?? t.pitchEconomyM) * scale;
    rowX.push(x);
    rowW.push(w);
    x += w;
  }

  const cabinX1 = x;
  const aftX1 = cabinX1 + t.aftService.lengthM * scale;
  const tailX = aftX1 + t.tailM * scale;

  const top = originY;
  const bottom = originY + cabinH;
  // Wings must fit the canvas: never reach past the top edge, and always leave
  // room beneath for the row numbers and the jetbridge lane.
  const wingSpan = Math.max(18, Math.min(54, top - 16, height - bottom - 46));

  return {
    rowX,
    rowW,
    seatH,
    gap,
    originY,
    seatTopY,
    aisleY: seatTopY + seatH * 3 + gap / 2,
    cabinH,
    cabinX0,
    cabinX1,
    fwdX0,
    aftX1,
    noseX,
    tailX,
    top,
    bottom,
    wingSpan,
    scale,
    // Anchored to the aircraft, not the canvas floor. Pinned to the bottom of a
    // tall frame it drifted away from the thing it belongs to.
    // Clear of the row numbers, which sit at bottom + wingSpan + 12.
    queueY: Math.min(height - 6, bottom + wingSpan + 64),
  };
}

/**
 * Vertical slot for a seat, 0-2 above the aisle and 3-5 below.
 * Left-side seats sit above the aisle, right-side below, both ordered so that
 * window seats are at the outside of the fuselage.
 */
function seatSlot(seat: Seat, maxDepth: number): number {
  // Slots run outboard-to-inboard. Scaling by the row's own maximum depth keeps
  // the window seat against the fuselage in a 2-2 row, leaving the *middle*
  // slot empty — which is what a two-abreast cabin actually looks like.
  const outboard = maxDepth <= 0 ? 0 : (2 * (maxDepth - seat.depth)) / maxDepth;
  return seat.side === 'left' ? outboard : 5 - outboard;
}

function seatRect(l: Layout, seat: Seat, maxDepth: number): [number, number, number, number] {
  const x = l.rowX[seat.row - 1] ?? 0;
  const w = l.rowW[seat.row - 1] ?? 0;
  const slot = seatSlot(seat, maxDepth);
  const y = l.seatTopY + slot * l.seatH + (slot >= 3 ? l.gap : 0);
  return [x + 1.5, y + 1, w - 3, l.seatH - 2];
}

/** Centre of an aisle cell. Cell 0 is the doorway, just ahead of row 1. */
function aisleX(l: Layout, pos: number): number {
  if (pos <= 0) return l.cabinX0 - (l.rowW[0] ?? 10) * 0.5;
  const i = Math.min(pos, l.rowX.length) - 1;
  return (l.rowX[i] ?? l.cabinX1) + (l.rowW[i] ?? 10) / 2;
}

export class CabinRenderer {
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
  }

  /**
   * Sizes the backing store to the element's CSS box at device resolution.
   *
   * The canvas takes whichever is larger of its frame and the width the cabin
   * needs to stay legible; when that exceeds the frame the wrapper scrolls. Its
   * height then follows from that width, so the drawing is exactly as tall as
   * it needs to be and the lane stays one block rather than two ends of a gap.
   */
  resize(cabin: Cabin): void {
    const frame = this.canvas.parentElement?.clientWidth ?? 0;
    const width = Math.max(frame, requiredWidth(cabin));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${requiredHeight(cabin, width)}px`;

    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(
    cabin: Cabin,
    snapshot: SimSnapshot,
    occupied: ReadonlySet<string>,
    binSlots: readonly number[] = [],
  ): void {
    const { ctx } = this;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const l = layout(cabin, w, h);

    ctx.fillStyle = COLORS.fuselage;
    ctx.fillRect(0, 0, w, h);

    this.drawWings(l, cabin);
    this.drawHull(l);
    this.drawService(l, cabin);
    this.drawBins(l, cabin, binSlots);
    this.drawAisle(l, cabin);
    this.drawSeats(l, cabin, occupied);
    this.drawSeated(l, cabin, occupied);
    this.drawExits(l, cabin);
    this.drawRowNumbers(l, cabin);
    this.drawAgents(l, cabin, snapshot);
    this.drawDoors(l, cabin);
    this.drawScale(l, cabin);
    this.drawQueue(l, cabin, snapshot);
  }

  /**
   * Wing root box and a swept stub.
   *
   * The real span is 34.1 m against a 3.63 m cabin, so a full planform at this
   * scale would be several times taller than the frame. The wing is drawn as
   * far as the box allows and deliberately runs off the edge rather than being
   * shrunk into a shape the aircraft does not have.
   */
  private drawWings(l: Layout, cabin: Cabin): void {
    const { ctx } = this;
    const [from, to] = cabin.features.wingRows;
    const x0 = l.rowX[from - 1] ?? l.cabinX0;
    const x1 = (l.rowX[to - 1] ?? l.cabinX1) + (l.rowW[to - 1] ?? 0);
    const span = l.wingSpan;
    const chord = x1 - x0;

    ctx.strokeStyle = COLORS.wingEdge;
    ctx.lineWidth = 1;

    for (const dir of [-1, 1]) {
      const rootY = dir < 0 ? l.top + 2 : l.bottom - 2;
      const tipY = rootY + dir * span;
      ctx.fillStyle = COLORS.wing;
      ctx.beginPath();
      ctx.moveTo(x0, rootY);
      ctx.lineTo(x1, rootY);
      // Sweep the leading edge back as the wing runs outboard.
      ctx.lineTo(x0 + chord * 0.78, tipY);
      ctx.lineTo(x0 + chord * 0.34, tipY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Engine nacelle, slung under the leading edge partway out the span.
      const nacelleY = rootY + dir * span * 0.5;
      ctx.fillStyle = COLORS.wingEdge;
      ctx.fillRect(x0 + chord * 0.02, nacelleY - span * 0.11, chord * 0.24, span * 0.22);
    }

    // Tailplane, at its own published span relative to the wing.
    const ratio = cabin.type.tailplaneSpanM / cabin.type.wingspanM;
    const tx0 = l.cabinX1 + (l.aftX1 - l.cabinX1) * 0.5;
    const tChord = Math.max(12, l.tailX - 10 - tx0);
    const tSpan = span * ratio * 1.6;
    for (const dir of [-1, 1]) {
      const rootY = dir < 0 ? l.top + 4 : l.bottom - 4;
      ctx.fillStyle = COLORS.wing;
      ctx.beginPath();
      ctx.moveTo(tx0, rootY);
      ctx.lineTo(tx0 + tChord, rootY);
      ctx.lineTo(tx0 + tChord * 0.72, rootY + dir * tSpan);
      ctx.lineTo(tx0 + tChord * 0.3, rootY + dir * tSpan);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  /** The fuselage outline: pointed nose, straight barrel, tapered tail. */
  private drawHull(l: Layout): void {
    const { ctx } = this;
    const midY = (l.top + l.bottom) / 2;

    ctx.beginPath();
    ctx.moveTo(l.fwdX0, l.top);
    ctx.lineTo(l.aftX1, l.top);
    // Tail cone.
    ctx.quadraticCurveTo(l.tailX, l.top + 2, l.tailX, midY - 4);
    ctx.lineTo(l.tailX, midY + 4);
    ctx.quadraticCurveTo(l.tailX, l.bottom - 2, l.aftX1, l.bottom);
    ctx.lineTo(l.fwdX0, l.bottom);
    // Nose cone.
    ctx.quadraticCurveTo(l.noseX, l.bottom, l.noseX, midY);
    ctx.quadraticCurveTo(l.noseX, l.top, l.fwdX0, l.top);
    ctx.closePath();

    ctx.fillStyle = COLORS.fuselage;
    ctx.fill();
    ctx.strokeStyle = COLORS.hull;
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // Flight-deck bulkhead.
    ctx.strokeStyle = COLORS.hullSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(l.fwdX0, l.top + 2);
    ctx.lineTo(l.fwdX0, l.bottom - 2);
    ctx.stroke();
  }

  /**
   * Galleys, lavatories, closets and attendant seats, drawn where the plan view
   * puts them.
   *
   * The real arrangement is asymmetric — a galley on one side of the forward
   * vestibule and a lavatory on the other — which a single hatched block hides.
   * Labels follow the manufacturer's legend: G galley, L lavatory, A attendant,
   * C closet, S stowage.
   */
  private drawService(l: Layout, cabin: Cabin): void {
    const { ctx } = this;
    const zones: [number, number, typeof cabin.type.forwardService][] = [
      [l.fwdX0, l.cabinX0, cabin.type.forwardService],
      [l.cabinX1, l.aftX1, cabin.type.aftService],
    ];

    for (const [x0, x1, zone] of zones) {
      ctx.fillStyle = COLORS.service;
      ctx.fillRect(x0, l.top, x1 - x0, l.bottom - l.top);

      const bySide = { left: 0, right: 0 };
      for (const f of zone.fixtures) bySide[f.side]++;

      for (const side of ['left', 'right'] as const) {
        const items = zone.fixtures
          .filter((f) => f.side === side)
          .sort((a, b) => a.order - b.order);
        if (items.length === 0) continue;

        const bandY = side === 'left' ? l.top : l.aisleY + l.gap / 2;
        const bandH =
          side === 'left' ? l.aisleY - l.gap / 2 - l.top : l.bottom - (l.aisleY + l.gap / 2);
        const w = (x1 - x0) / items.length;

        items.forEach((fixture, i) => {
          const fx = x0 + i * w;
          ctx.fillStyle = fixture.kind === 'attendant' ? COLORS.aisle : COLORS.serviceHatch;
          ctx.fillRect(fx + 1, bandY + 1, w - 2, bandH - 2);
          ctx.strokeStyle = COLORS.hullSoft;
          ctx.lineWidth = 1;
          ctx.strokeRect(fx + 1.5, bandY + 1.5, w - 3, bandH - 3);

          if (w > 12 && bandH > 12) {
            ctx.fillStyle = COLORS.text;
            ctx.font = canvasFont(TYPE.micro, WEIGHT.medium);
            ctx.textAlign = 'center';
            ctx.fillText(
              FIXTURE_LABEL[fixture.kind] ?? '?',
              fx + w / 2,
              bandY + bandH / 2 + 3,
            );
          }
        });
      }
      void bySide;
    }
  }

  /**
   * Overhead stowage, drawn as a bin strip outboard of each seat band and
   * filling as bags go in.
   *
   * Bin capacity drives a real part of the simulation — late boarders hunt for
   * space and hold up the aisle doing it — and none of that was visible.
   */
  private drawBins(l: Layout, cabin: Cabin, remaining: readonly number[]): void {
    const { ctx } = this;
    const capacity = cabin.config.binSlotsPerRow;
    if (capacity <= 0) return;
    const h = Math.max(2.5, Math.min(6, l.seatH * 0.3));

    for (let row = 1; row <= cabin.config.rows; row++) {
      const x = l.rowX[row - 1];
      const w = l.rowW[row - 1];
      if (x === undefined || w === undefined) continue;

      const left = remaining[row] ?? capacity;
      const used = Math.max(0, Math.min(1, (capacity - left) / capacity));

      for (const y of [l.top - h - 1.5, l.bottom + 1.5]) {
        ctx.fillStyle = COLORS.binEmpty;
        ctx.fillRect(x + 1, y, w - 2, h);
        if (used > 0) {
          // Amber through to red as the bin runs out.
          ctx.fillStyle = used >= 0.999 ? COLORS.binFull : COLORS.binUsed;
          ctx.fillRect(x + 1, y, (w - 2) * used, h);
        }
      }
    }
  }

  private drawAisle(l: Layout, cabin: Cabin): void {
    const { ctx } = this;
    ctx.fillStyle = COLORS.aisle;
    ctx.fillRect(l.fwdX0, l.aisleY - l.gap / 2, l.aftX1 - l.fwdX0, l.gap);
    ctx.strokeStyle = COLORS.serviceHatch;
    ctx.lineWidth = 1;
    for (const dy of [-l.gap / 2, l.gap / 2]) {
      ctx.beginPath();
      ctx.moveTo(l.cabinX0, l.aisleY + dy);
      ctx.lineTo(l.cabinX1, l.aisleY + dy);
      ctx.stroke();
    }
    void cabin;
  }

  private drawSeats(l: Layout, cabin: Cabin, occupied: ReadonlySet<string>): void {
    const { ctx } = this;

    for (const seat of cabin.seats) {
      const [x, y, w, h] = seatRect(l, seat, maxDepth(cabin, seat.row));
      const taken = occupied.has(`${seat.row}:${seat.letter}`);

      ctx.fillStyle = taken
        ? COLORS.seatTaken
        : seat.cabinClass === 'first'
          ? COLORS.firstClass
          : COLORS.seatEmpty;
      ctx.fillRect(x, y, w, h);

      // A seat back on the forward edge, so seats read as seats.
      if (w > 7) {
        ctx.fillStyle = taken ? COLORS.seatTakenBack : COLORS.seatBack;
        ctx.fillRect(x, y, Math.max(2, w * 0.22), h);
      }

      ctx.strokeStyle = COLORS.seatEdge;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
  }

  /** Overwing exits: a gap in the hull plus a marker on each side. */
  private drawExits(l: Layout, cabin: Cabin): void {
    const { ctx } = this;
    for (const row of cabin.features.exitRows) {
      const x = l.rowX[row - 1];
      const w = l.rowW[row - 1];
      if (x === undefined || w === undefined) continue;

      ctx.strokeStyle = COLORS.exit;
      ctx.lineWidth = 3;
      for (const y of [l.top, l.bottom]) {
        ctx.beginPath();
        ctx.moveTo(x + w * 0.2, y);
        ctx.lineTo(x + w * 0.8, y);
        ctx.stroke();
      }
    }

    if (cabin.features.exitRows.length === 0) return;
    const first = cabin.features.exitRows[0] as number;
    const fx = l.rowX[first - 1];
    if (fx === undefined) return;
    ctx.fillStyle = COLORS.exit;
    ctx.font = canvasFont(TYPE.micro, WEIGHT.medium);
    ctx.textAlign = 'left';
    ctx.fillText('exit', fx, l.top - 6);
  }

  private drawRowNumbers(l: Layout, cabin: Cabin): void {
    const { ctx } = this;
    const step = (l.rowW[0] ?? 0) >= 15 ? 1 : (l.rowW[0] ?? 0) >= 9 ? 2 : 5;
    ctx.fillStyle = COLORS.text;
    ctx.font = canvasFont(TYPE.micro);
    ctx.textAlign = 'center';
    for (let row = 1; row <= cabin.config.rows; row++) {
      if (row % step !== 0 && row !== 1) continue;
      const x = (l.rowX[row - 1] ?? 0) + (l.rowW[row - 1] ?? 0) / 2;
      ctx.fillText(String(row), x, l.bottom + l.wingSpan + 12);
    }
  }

  /**
   * Passengers, drawn as figures rather than dots.
   *
   * Everything here is presentation. Position is interpolated between the aisle
   * cells the simulation actually uses, and the gait phase is a pure function of
   * passenger id and simulated time — no engine state is read that is not
   * already fixed, and none is written. The model is a one-per-cell queue, so
   * nobody is ever drawn overtaking anybody: that would be depicting mechanics
   * the simulation does not have.
   */
  private drawAgents(l: Layout, cabin: Cabin, snapshot: SimSnapshot): void {
    const { ctx } = this;
    const r = Math.max(2.2, Math.min(l.rowW[0] ?? 10, l.gap) * 0.3);

    // Who is standing where, so somebody held up can be drawn closing the gap
    // rather than parked in the middle of a cell with a hole in front of them.
    const atCell = new Map<number, AgentState>();
    for (const agent of snapshot.agents) {
      if (agent.pos >= 0 && agent.state !== 'seated') atCell.set(agent.pos, agent);
    }

    for (const agent of snapshot.agents) {
      if (agent.pos < 0) continue;

      const target = aisleX(l, agent.pos);
      let x = target;
      if (agent.state === 'walking' && agent.stepDuration > 0 && agent.fromPos >= 0) {
        // A person does not cross a row at a constant speed and then stop dead.
        // Easing each step is the single thing that makes the queue read as
        // people walking rather than counters sliding between squares.
        const raw = Math.min(1, Math.max(0, 1 - agent.timer / agent.stepDuration));
        const eased = raw < 0.5 ? 2 * raw * raw : 1 - 2 * (1 - raw) * (1 - raw);
        const from = aisleX(l, agent.fromPos);
        x = from + (target - from) * eased;
      }

      if (agent.blocked && atCell.has(agent.pos + 1)) {
        // Closed up on whoever is in the way, the way a queue actually stands.
        x += (l.rowW[agent.pos] ?? 10) * 0.18;
      }

      const seat = agent.passenger.seat;
      const [sx, sy, sw, sh] = seatRect(l, seat, maxDepth(cabin, seat.row));
      const seatCentreY = sy + sh / 2;
      const toSeat = Math.sign(seatCentreY - l.aisleY) || 1;

      // Square on to the aisle while walking; turned toward the row to work at
      // the bins, and turned the rest of the way to sit down.
      let y = l.aisleY;
      let angle = 0;

      if (agent.state === 'stowing') {
        angle = toSeat * 0.85;
        y = l.aisleY + toSeat * r * 0.28;
      }

      if (agent.state === 'shuffling' && agent.stepDuration >= 0) {
        // Stepping out of the aisle into the row: sliding toward the seat while
        // turning to face it, so sitting down reads as a movement. The turn
        // leads the slide, as it does in a real aisle.
        const total = Math.max(0.001, agent.timer + 0.001);
        const settle = Math.min(1, Math.max(0, 1 - total / 4));
        y = l.aisleY + (seatCentreY - l.aisleY) * settle * 0.55;
        x = x + (sx + sw / 2 - x) * settle * 0.55;
        angle = toSeat * (Math.PI / 2) * Math.min(1, settle * 1.6);
      }

      // A gait, phase-locked to the passenger and the clock, and quicker for a
      // quicker walker. Deterministic, and read-only with respect to the model.
      let swing = 0;
      if (agent.state === 'walking' && !agent.blocked && !REDUCED_MOTION) {
        const cadence = 5.5 / Math.max(0.5, agent.passenger.slowFactor);
        swing = Math.sin(agent.passenger.id * 1.7 + snapshot.time * cadence);
        // Weight shifting from one foot to the other, seen from above.
        y += swing * r * 0.2;
        angle += swing * 0.1;
      }

      const color = this.agentColor(agent);
      this.drawFigure(x, y, r, color, agent, angle, swing);

      if (agent.state !== 'seated') {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
        ctx.globalAlpha = 1;
      }

      // Anybody who had to get up to let this passenger past is on their feet
      // in the aisle. The simulation has always charged for this — it is the
      // seat interference the whole literature is about — but it was only ever
      // a number and a halo, and the halo does not say who is standing or why.
      agent.displaced.forEach((stood, i) => {
        const [bx, , bw] = seatRect(l, stood, maxDepth(cabin, stood.row));
        // Out into the aisle and a pace forward, which is where you go to let
        // somebody into your row — not standing in the row you just left. Each
        // extra person stands one further along, because two of them cannot be
        // in the same place and the queue behind can see exactly why it waits.
        const aside = bw * (0.45 + i * 0.55);
        this.drawStanding(bx + bw / 2 - aside, l.aisleY - toSeat * r * 0.75, r, toSeat);
      });
    }

    this.drawCrew(l, snapshot, r);
  }

  /** A neighbour on their feet in the aisle: no bag, turned to their own row. */
  private drawStanding(x: number, y: number, r: number, facing: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(facing * (Math.PI / 2));
    ctx.globalAlpha = 0.9;

    ctx.fillStyle = COLORS.shuffling;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.7, r * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = COLORS.head;
    ctx.beginPath();
    ctx.arc(r * 0.16, 0, r * 0.36, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /**
   * The assistance crew, drawn offset from the aisle centre line.
   *
   * They share a cell with whoever they are passing — that is the whole point
   * of the outbound lane — so drawing them on the centre line would put two
   * figures on top of each other. The offset is the visual form of "somebody
   * pressed into a row to let them by", and the direction they face is the
   * direction they are walking, which is the thing worth seeing: on the way in
   * they move with the queue, on the way out straight against it.
   */
  private drawCrew(l: Layout, snapshot: SimSnapshot, r: number): void {
    const { ctx } = this;

    for (const member of snapshot.crew) {
      if (member.pos < 0) continue;

      const target = aisleX(l, member.pos);
      let x = target;
      const moving = member.state === 'escorting' || member.state === 'leaving';
      if (moving && member.stepDuration > 0 && member.fromPos >= 0) {
        const from = aisleX(l, member.fromPos);
        const progress = Math.min(1, Math.max(0, 1 - member.timer / member.stepDuration));
        x = from + (target - from) * progress;
      }

      // Offset only once they are actually in the outbound lane; an escort who
      // has turned round but not yet found a gap is still in the queue's way,
      // and should be drawn standing in it.
      const outbound = member.lane === 'exit';
      const y = l.aisleY + (outbound ? -r * 0.85 : r * 0.85);
      const color = member.state === 'leaving' ? COLORS.crewLeaving : COLORS.crew;

      // A plain disc with a heading tick: crew are not passengers and should
      // not be counted as one at a glance.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.72, 0, Math.PI * 2);
      ctx.fill();

      if (r > 3) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + member.heading * r * 1.25, y);
        ctx.stroke();
      }

      if (member.state === 'transferring' && r > 3) {
        // Mid-lift: a held ring, so a stalled aisle has a visible cause.
        ctx.strokeStyle = COLORS.aisleChair;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.15, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /**
   * A figure seen from above: shoulders, a head, arms, and whatever they are
   * carrying.
   *
   * Drawn in the body's own frame and then rotated, so somebody turning into a
   * row turns rather than sliding sideways still square to the aisle, and the
   * bag stays in the hand holding it.
   */
  private drawFigure(
    x: number,
    y: number,
    r: number,
    color: string,
    agent: AgentState,
    angle: number,
    swing: number,
  ): void {
    const { ctx } = this;
    const carried = agent.passenger.bags - agent.gateCheckedBags;
    // Smaller people are smaller; the manifest already says who is a child.
    const scale = agent.passenger.isChild ? 0.78 : 1;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(scale, scale);

    // Carried luggage, in the trailing hand, gone once it is in the bin.
    if (carried > 0 && agent.state !== 'seated' && r > 3) {
      ctx.fillStyle = COLORS.bag;
      const bw = r * 0.72;
      // Lifted toward the bin over the course of the stow.
      const lift = agent.state === 'stowing' ? r * 0.95 : 0;
      // Close to the body: it is being wheeled, not carried at arm's length.
      ctx.fillRect(-r * 0.98, -bw / 2 - lift, bw, bw);
    }

    // Shoulders: narrow along the walk, broad across it.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.74, r, 0, 0, Math.PI * 2);
    ctx.fill();

    // Arms, swinging out of phase with one another.
    if (r > 3.4 && agent.state === 'walking' && !REDUCED_MOTION) {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(swing * side * r * 0.34, side * r * 0.8, r * 0.17, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Head, offset forward.
    ctx.fillStyle = COLORS.head;
    ctx.beginPath();
    ctx.arc(r * 0.2, 0, r * 0.36, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // A halo still marks a stall, drawn unrotated so it stays a circle.
    if (agent.state === 'stowing' || agent.state === 'shuffling') {
      ctx.beginPath();
      ctx.arc(x, y, r + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /** Seated passengers, so a filled cabin reads as people rather than blocks. */
  private drawSeated(l: Layout, cabin: Cabin, occupied: ReadonlySet<string>): void {
    const { ctx } = this;
    for (const seat of cabin.seats) {
      if (!occupied.has(`${seat.row}:${seat.letter}`)) continue;
      const [x, y, w, h] = seatRect(l, seat, maxDepth(cabin, seat.row));
      if (w < 6 || h < 6) continue;
      ctx.fillStyle = COLORS.head;
      ctx.beginPath();
      ctx.arc(x + w * 0.62, y + h / 2, Math.min(w, h) * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private agentColor(agent: AgentState): string {
    // An aisle chair keeps its own colour throughout: it is the thing on screen
    // whose progress explains everybody else's.
    if (agent.passenger.assistance === 'aisle-chair' && agent.state !== 'seated') {
      return agent.blocked ? COLORS.blocked : COLORS.aisleChair;
    }
    switch (agent.state) {
      case 'stowing':
        return COLORS.stowing;
      case 'shuffling':
        return COLORS.shuffling;
      case 'walking':
        return agent.blocked ? COLORS.blocked : COLORS.walking;
      default:
        return COLORS.walking;
    }
  }

  /**
   * Passenger doors and overwing exits at their published stations.
   *
   * A narrow-body carries four passenger doors, not one — 1L/1R forward and
   * 2L/2R aft — plus the overwing exits between them. Boarding uses 1L, which
   * is why that one is picked out; the rest are drawn because they are there.
   */
  private drawDoors(l: Layout, cabin: Cabin): void {
    const { ctx } = this;
    const t = cabin.type;

    for (const door of t.doors) {
      if (door.type !== 'passenger') continue;
      const x = l.noseX + door.stationM * l.scale;
      if (x < l.noseX || x > l.tailX) continue;
      const boarding = door.id === '1L';
      const y = door.id.endsWith('L') ? l.top : l.bottom;

      ctx.strokeStyle = boarding ? COLORS.textBright : COLORS.hullSoft;
      ctx.lineWidth = boarding ? 4 : 2.5;
      ctx.beginPath();
      ctx.moveTo(x - l.scale * 0.4, y);
      ctx.lineTo(x + l.scale * 0.4, y);
      ctx.stroke();

      if (boarding) {
        ctx.fillStyle = COLORS.textBright;
        ctx.font = canvasFont(TYPE.micro, WEIGHT.medium);
        ctx.textAlign = 'center';
        ctx.fillText('1L', x, l.top - 7);
      }
    }
  }

  /** A scale bar, because a drawing claiming to be to scale should show it. */
  private drawScale(l: Layout, cabin: Cabin): void {
    const { ctx } = this;
    const metres = 5;
    const w = metres * l.scale;
    if (w < 24) return;
    const x = l.noseX;
    const y = l.queueY - 26;

    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y - 3);
    ctx.stroke();

    ctx.fillStyle = COLORS.text;
    ctx.font = canvasFont(TYPE.micro);
    ctx.textAlign = 'left';
    ctx.fillText(`${metres} m`, x + w + 6, y + 2);
    ctx.fillText(cabin.type.name, x + w + 44, y + 2);
  }

  /**
   * The queue still on the jetbridge, in boarding order, coloured by how far
   * down the cabin each passenger is headed.
   *
   * This is where a strategy becomes legible before anything happens: a
   * back-to-front queue is a clean gradient, Steffen's alternates, and random
   * boarding is noise.
   */
  /**
   * The gate, the airbridge, and everybody still on the wrong side of the door.
   *
   * The simulation models the gate as an order and a set of release groups; it
   * has no notion of where anybody is standing before they reach the doorway.
   * So nothing here is a simulated position. What is drawn is queue order —
   * place in the line, which is real — laid along a bridge and a lounge, and
   * the release group each passenger belongs to, which is the whole subject of
   * the strategies and was until now invisible outside a slider.
   *
   * Nobody on the bridge moves under their own steam. They are the next few in
   * the queue, drawn where they stand in it; when the person at the door boards
   * everyone behind is one place further forward, which is exactly what the
   * queue did.
   */
  private drawQueue(l: Layout, cabin: Cabin, snapshot: SimSnapshot): void {
    const waiting = snapshot.agents
      .filter((a) => a.state === 'queued')
      .sort((a, b) => a.order - b.order);

    if (showsGate(l.tailX)) this.drawGate(l, cabin, waiting, snapshot.total);
    else this.drawQueueStrip(l, cabin, waiting);
  }

  /** The full drawing: lounge, desk, bridge, door. */
  private drawGate(
    l: Layout,
    cabin: Cabin,
    waiting: AgentState[],
    total: number,
  ): void {
    const { ctx } = this;

    // Above the aircraft, because that is the side door 1L is on. The band fits
    // in the clearance `layout` already leaves over the cabin, so showing the
    // gate costs no height at all.
    const doorX = l.noseX + (boardingDoorM(cabin) ?? 0) * l.scale;
    // Clear of the wings: a terminal drawn over a wing root reads as a mistake
    // about what is on top of what.
    const bottom = l.top - l.wingSpan - 8;
    const top = bottom - 44;
    const y = (top + bottom) / 2;

    const cell = 6;
    // The lounge holds the whole manifest, so it starts full and visibly
    // empties. Sizing it to whoever is left would shrink the room as the flight
    // boards, which is not a thing rooms do.
    const rows = Math.max(1, Math.floor((bottom - top - 8) / cell));
    const cols = Math.max(8, Math.ceil(total / rows));
    const bridgeRun = 104;
    const loungeX0 = doorX + bridgeRun;
    const loungeX1 = Math.min(l.tailX, loungeX0 + cols * cell + 12);

    // Airbridge: a corridor from the desk to the door, and the throat where it
    // meets the aircraft.
    ctx.fillStyle = COLORS.service;
    ctx.fillRect(doorX, y - 8, loungeX0 - doorX, 16);
    ctx.strokeStyle = COLORS.hullSoft;
    ctx.lineWidth = 1;
    ctx.strokeRect(doorX + 0.5, y - 7.5, loungeX0 - doorX - 1, 15);
    ctx.beginPath();
    ctx.moveTo(doorX + 0.5, y + 8);
    ctx.lineTo(doorX + 0.5, l.top);
    ctx.stroke();

    // The lounge, and the desk where the group is called.
    ctx.fillStyle = COLORS.fuselage;
    ctx.fillRect(loungeX0, top, loungeX1 - loungeX0, bottom - top);
    ctx.strokeRect(loungeX0 + 0.5, top + 0.5, loungeX1 - loungeX0 - 1, bottom - top - 1);
    ctx.fillStyle = COLORS.serviceHatch;
    ctx.fillRect(loungeX0 - 4, y - 11, 4, 22);

    const colours = groupPalette(waiting);

    // On the bridge: the next few, single file, nearest the door first.
    const onBridge = Math.min(waiting.length, Math.floor((bridgeRun - 20) / 11));
    for (let i = 0; i < onBridge; i++) {
      const agent = waiting[i] as AgentState;
      ctx.fillStyle = colours(agent, cabin);
      ctx.beginPath();
      ctx.arc(doorX + 13 + i * 11, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // In the lounge: everyone else, in queue order, wrapped into rows.
    const rest = waiting.slice(onBridge);
    const shown = Math.min(rest.length, cols * rows);
    for (let i = 0; i < shown; i++) {
      const agent = rest[i] as AgentState;
      ctx.fillStyle = colours(agent, cabin);
      ctx.fillRect(
        loungeX0 + 6 + (i % cols) * cell,
        top + 4 + Math.floor(i / cols) * cell,
        cell - 1.6,
        cell - 1.6,
      );
    }

    ctx.font = canvasFont(TYPE.micro, WEIGHT.medium);
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.text;
    ctx.fillText('airbridge', doorX + 1, top - 6);
    const next = waiting[0];
    ctx.fillText(
      next
        ? `gate \u00b7 ${waiting.length} waiting \u00b7 calling group ${next.group + 1}`
        : 'gate \u00b7 everyone aboard',
      loungeX0,
      top - 6,
    );

    if (rest.length > shown) {
      ctx.textAlign = 'right';
      ctx.fillText(`+${rest.length - shown}`, loungeX1 - 4, top - 6);
      ctx.textAlign = 'left';
    }
  }

  /** The compact form, for a frame too narrow to hold the gate. */
  private drawQueueStrip(l: Layout, cabin: Cabin, waiting: AgentState[]): void {
    const { ctx } = this;

    ctx.fillStyle = COLORS.text;
    ctx.font = canvasFont(TYPE.micro, WEIGHT.medium);
    ctx.textAlign = 'left';
    ctx.fillText(`gate \u00b7 ${waiting.length} waiting`, l.noseX, l.queueY - 11);

    if (waiting.length === 0) return;

    const colours = groupPalette(waiting);
    const dot = 4;
    const slots = Math.max(1, Math.floor((l.tailX - l.noseX) / (dot + 2)));
    const shown = waiting.slice(0, slots);

    for (let i = 0; i < shown.length; i++) {
      const agent = shown[i] as AgentState;
      ctx.fillStyle = colours(agent, cabin);
      ctx.fillRect(l.noseX + i * (dot + 2), l.queueY - dot, dot, dot);
    }

    if (waiting.length > shown.length) {
      ctx.fillStyle = COLORS.text;
      ctx.fillText(
        `+${waiting.length - shown.length}`,
        l.noseX + shown.length * (dot + 2) + 4,
        l.queueY,
      );
    }
  }
}

/** Front of cabin (blue) through to the rear (orange). */
/**
 * How to colour the people still waiting.
 *
 * By release group when the gate uses a handful of them, because that is the
 * thing the strategies actually set and the one place it can be seen: four
 * blocks of colour in the lounge *is* back-to-front, and one block is random
 * boarding whatever the picker says. A strictly ordered queue gives every
 * passenger their own group, at which point the colours would be noise — so
 * that falls back to seat position, which is what the queue is sorted by.
 */
function groupPalette(
  waiting: AgentState[],
): (agent: AgentState, cabin: Cabin) => string {
  const groups = new Set(waiting.map((a) => a.group));
  if (groups.size > GROUP_COLORS.length) {
    return (agent, cabin) =>
      queueColor((agent.passenger.seat.row - 1) / Math.max(1, cabin.config.rows - 1));
  }
  const order = [...groups].sort((a, b) => a - b);
  return (agent) =>
    GROUP_COLORS[order.indexOf(agent.group) % GROUP_COLORS.length] as string;
}

function queueColor(t: number): string {
  const k = Math.min(1, Math.max(0, t));
  return `rgb(${Math.round(91 + k * 164)},${Math.round(147 - k * 40)},${Math.round(240 - k * 187)})`;
}

/** Canvas state colours, so the legend cannot drift out of sync with the draw. */
export const STATE_COLORS: Record<string, string> = {
  walking: COLORS.walking,
  blocked: COLORS.blocked,
  stowing: COLORS.stowing,
  shuffling: COLORS.shuffling,
  seated: COLORS.seatTaken,
  aisleChair: COLORS.aisleChair,
  crew: COLORS.crew,
};

export { COLORS, GROUP_COLORS };
