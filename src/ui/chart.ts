import { formatDuration } from '../engine/stats.ts';
import { TYPE, WEIGHT } from './type.ts';
import type { Equity } from '../engine/equity.ts';
import type { StrategyResult, SweepAxis, SweepResult } from '../engine/batch.ts';
import { GROUP_COLORS } from '../render/cabin-canvas.ts';

/**
 * Two small SVG charts: the live boarding curve, and the Monte Carlo comparison
 * across strategies. Hand-rolled rather than pulled from a library — they are
 * simple enough that a dependency would cost more than it saves.
 */

const AXIS = '#232b3d';
const LABEL = '#98a2b6';

export { formatDuration } from '../engine/stats.ts';

function svg(w: number, h: number, body: string): string {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${body}</svg>`;
}

export interface CurveSeries {
  label: string;
  color: string;
  points: { t: number; seated: number }[];
}

/**
 * Seated-passenger count over time, for one or more runs on shared axes.
 *
 * The shape carries information the totals do not: a strategy that parallelises
 * well climbs in a straight diagonal, while a serialised one shows a shallow
 * ramp with visible plateaus wherever the aisle jammed.
 */
export function boardingCurve(
  series: CurveSeries[],
  total: number,
  width = 520,
  height = 200,
): string {
  const drawable = series.filter((s) => s.points.length >= 2);
  if (drawable.length === 0) return svg(width, height, '');

  const padL = 34;
  const padB = 20;
  const maxT = Math.max(
    1,
    ...drawable.map((s) => s.points.at(-1)!.t),
  );
  const x = (t: number): number => padL + (t / maxT) * (width - padL - 8);
  const y = (n: number): number => height - padB - (n / total) * (height - padB - 12);

  const gridlines = [0, 0.5, 1]
    .map((f) => {
      const gy = y(total * f);
      return (
        `<line x1="${padL}" y1="${gy}" x2="${width - 8}" y2="${gy}" stroke="${AXIS}" stroke-width="1"/>` +
        `<text x="${padL - 6}" y="${gy + 3}" fill="${LABEL}" font-size="${TYPE.micro}" text-anchor="end">${Math.round(total * f)}</text>`
      );
    })
    .join('');

  const lines = drawable
    .map((s) => {
      // Thin the polyline to roughly one point per horizontal pixel.
      const stride = Math.max(1, Math.floor(s.points.length / width));
      const pts: string[] = [];
      for (let i = 0; i < s.points.length; i += stride) {
        const p = s.points[i]!;
        pts.push(`${x(p.t).toFixed(1)},${y(p.seated).toFixed(1)}`);
      }
      const last = s.points.at(-1)!;
      pts.push(`${x(last.t).toFixed(1)},${y(last.seated).toFixed(1)}`);
      const joined = pts.join(' ');

      const area =
        drawable.length === 1
          ? `<polygon points="${padL},${height - padB} ${joined} ${x(last.t).toFixed(1)},${height - padB}" fill="${s.color}" opacity="0.14"/>`
          : '';
      return (
        area + `<polyline points="${joined}" fill="none" stroke="${s.color}" stroke-width="2"/>`
      );
    })
    .join('');

  const legend =
    drawable.length > 1
      ? drawable
          .map(
            (s, i) =>
              `<circle cx="${padL + 8 + i * 130}" cy="10" r="3.5" fill="${s.color}"/>` +
              `<text x="${padL + 16 + i * 130}" y="13" fill="${LABEL}" font-size="${TYPE.micro}">${s.label}</text>`,
          )
          .join('')
      : '';

  return svg(
    width,
    height,
    gridlines +
      lines +
      legend +
      `<text x="${width - 8}" y="${height - 6}" fill="${LABEL}" font-size="${TYPE.micro}" text-anchor="end">${formatDuration(maxT)}</text>` +
      `<text x="${padL}" y="${height - 6}" fill="${LABEL}" font-size="${TYPE.micro}">0:00</text>`,
  );
}

/**
 * Ranked comparison across strategies: a bar at the median with an
 * interquartile whisker, so the spread between runs stays visible. Overlapping
 * whiskers mean the difference is not resolved by this many trials.
 */
/**
 * Sensitivity sweep: one line per strategy across the values of one parameter.
 *
 * The interesting features are the crossings and the convergences — the points
 * where a strategy's advantage appears, or stops existing.
 */
export function sweepChart(
  axis: SweepAxis,
  result: SweepResult,
  width = 520,
  height = 300,
): string {
  const drawable = result.series.filter((s) => s.medians.length > 0);
  if (drawable.length === 0) return '';

  const padL = 44;
  const padB = 46;
  const padT = 10;
  const all = drawable.flatMap((s) => s.medians);
  const min = Math.min(...all) * 0.95;
  const max = Math.max(...all) * 1.02;

  const n = axis.values.length;
  const x = (i: number): number =>
    padL + (n === 1 ? 0 : (i / (n - 1)) * (width - padL - 96));
  const y = (v: number): number =>
    height - padB - ((v - min) / (max - min || 1)) * (height - padB - padT);

  const gridlines = [0, 0.5, 1]
    .map((f) => {
      const value = min + f * (max - min);
      const gy = y(value);
      return (
        `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${width - 96}" y2="${gy.toFixed(1)}" stroke="${AXIS}" stroke-width="1"/>` +
        `<text x="${padL - 6}" y="${(gy + 3).toFixed(1)}" fill="${LABEL}" font-size="${TYPE.micro}" text-anchor="end">${formatDuration(value)}</text>`
      );
    })
    .join('');

  const xLabels = axis.values
    .map(
      (v, i) =>
        `<text x="${x(i).toFixed(1)}" y="${height - padB + 14}" fill="${LABEL}" font-size="${TYPE.micro}" text-anchor="middle">${axis.format(v)}</text>`,
    )
    .join('');

  // Where several strategies finish at similar times their end labels would
  // overlap into mush, so nudge them apart while keeping their vertical order.
  const labelSlots = drawable
    .map((s, si) => ({ si, y: y(s.medians.at(-1) as number) }))
    .sort((a, b) => a.y - b.y);
  const MIN_GAP = 11;
  for (let i = 1; i < labelSlots.length; i++) {
    const prev = labelSlots[i - 1]!;
    const cur = labelSlots[i]!;
    if (cur.y - prev.y < MIN_GAP) cur.y = prev.y + MIN_GAP;
  }
  const labelY = new Map(labelSlots.map((slot) => [slot.si, slot.y]));

  const lines = drawable
    .map((s, si) => {
      const color = GROUP_COLORS[si % GROUP_COLORS.length] as string;
      const pts = s.medians.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const dots = s.medians
        .map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${color}"/>`)
        .join('');

      const endX = x(axis.values.length - 1);
      const endY = y(s.medians.at(-1) as number);
      const ly = labelY.get(si) ?? endY;
      // A leader line keeps a nudged label attached to its series.
      const leader =
        Math.abs(ly - endY) > 1.5
          ? `<line x1="${endX.toFixed(1)}" y1="${endY.toFixed(1)}" x2="${width - 94}" y2="${ly.toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.4"/>`
          : '';
      const legend =
        `<text x="${width - 90}" y="${(ly + 3).toFixed(1)}" fill="${color}" font-size="${TYPE.micro}">${s.name}</text>`;
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>${dots}${leader}${legend}`;
    })
    .join('');

  return svg(
    width,
    height,
    gridlines +
      lines +
      xLabels +
      `<text x="${(padL + (width - 96)) / 2}" y="${height - 6}" fill="${LABEL}" font-size="${TYPE.micro}" text-anchor="middle">${axis.label}</text>`,
  );
}

/**
 * Optimizer convergence: best-so-far objective against candidates evaluated.
 * A curve that flattens early means the search has converged; one still falling
 * at the right-hand edge means it was stopped too soon.
 */
export function convergenceChart(
  history: number[],
  baseline: number | null,
  width = 520,
  height = 120,
): string {
  if (history.length < 2) return svg(width, height, '');

  const padL = 40;
  const padB = 16;
  const values = baseline === null ? history : [...history, baseline];
  const lo = Math.min(...values) * 0.995;
  const hi = Math.max(...values) * 1.005;

  const x = (i: number): number => padL + (i / (history.length - 1)) * (width - padL - 8);
  const y = (v: number): number =>
    height - padB - ((v - lo) / (hi - lo || 1)) * (height - padB - 10);

  const pts = history.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const baselineMark =
    baseline === null
      ? ''
      : `<line x1="${padL}" y1="${y(baseline).toFixed(1)}" x2="${width - 8}" y2="${y(baseline).toFixed(1)}" ` +
        `stroke="#ff6b35" stroke-width="1" stroke-dasharray="4 3"/>` +
        `<text x="${width - 10}" y="${(y(baseline) - 4).toFixed(1)}" fill="#ff6b35" font-size="${TYPE.micro}" text-anchor="end">best named strategy</text>`;

  return svg(
    width,
    height,
    baselineMark +
      `<polyline points="${pts}" fill="none" stroke="#4ade80" stroke-width="2"/>` +
      `<text x="${padL - 6}" y="${(y(Math.min(...history)) + 3).toFixed(1)}" fill="${LABEL}" font-size="${TYPE.micro}" text-anchor="end">${formatDuration(Math.min(...history))}</text>` +
      `<text x="${padL}" y="${height - 4}" fill="${LABEL}" font-size="${TYPE.micro}">candidates evaluated →</text>`,
  );
}

export function comparisonChart(
  results: StrategyResult[],
  highlight: string,
  width = 520,
): string {
  if (results.length === 0) return '';
  const max = Math.max(...results.map((r) => r.p75)) * 1.05;
  const rowH = 30;
  const labelW = 130;
  const height = results.length * rowH + 8;

  const body = results
    .map((r, i) => {
      const y = i * rowH + 6;
      const barH = 13;
      const scale = (v: number): number => labelW + (v / max) * (width - labelW - 52);
      // Every strategy keeps its own palette colour; the selected one is marked
      // with an outline instead, so highlighting cannot collide with a hue
      // already in use elsewhere in the chart.
      const color = GROUP_COLORS[i % GROUP_COLORS.length] as string;
      const selected = r.strategy === highlight;
      const outline = selected ? ' stroke="#f2ede4" stroke-width="1.5"' : '';
      return (
        `<text x="${labelW - 8}" y="${y + barH - 2}" fill="${selected ? '#dbe4ee' : LABEL}" font-size="${TYPE.micro}" ` +
        `font-weight="${selected ? 600 : 400}" text-anchor="end">${r.name}</text>` +
        `<rect x="${labelW}" y="${y}" width="${(scale(r.median) - labelW).toFixed(1)}" height="${barH}" fill="${color}" opacity="0.85" rx="2"${outline}/>` +
        `<line x1="${scale(r.p25).toFixed(1)}" y1="${y + barH / 2}" x2="${scale(r.p75).toFixed(1)}" y2="${y + barH / 2}" stroke="#f2ede4" stroke-width="1" opacity="0.7"/>` +
        `<line x1="${scale(r.p25).toFixed(1)}" y1="${y + 2}" x2="${scale(r.p25).toFixed(1)}" y2="${y + barH - 2}" stroke="#f2ede4" stroke-width="1" opacity="0.7"/>` +
        `<line x1="${scale(r.p75).toFixed(1)}" y1="${y + 2}" x2="${scale(r.p75).toFixed(1)}" y2="${y + barH - 2}" stroke="#f2ede4" stroke-width="1" opacity="0.7"/>` +
        // Figures align on tabular-nums rather than a typewriter face.
        `<text x="${width - 48}" y="${y + barH - 2}" fill="#f2ede4" font-size="${TYPE.data}" font-weight="${WEIGHT.medium}" ` +
        `style="font-variant-numeric:tabular-nums">${formatDuration(r.median)}</text>`
      );
    })
    .join('');

  return svg(width, height, body);
}


/**
 * Imposed delay by seat row, drawn on the same left-to-right axis as the cabin.
 *
 * Aligning it with the aircraft is the point: you can see which part of the
 * plane is paying for the speed, rather than reading it out of a table.
 */
export function waitByRowChart(equity: Equity, width = 520, height = 120): string {
  const rows = equity.byRow.length;
  if (rows === 0) return '';

  const padL = 34;
  const padB = 16;
  const peak = Math.max(1, ...equity.byRow);
  const barW = (width - padL - 8) / rows;
  const plot = height - padB - 10;

  const bars = equity.byRow
    .map((seconds, i) => {
      const h = Math.max(0, (seconds / peak) * plot);
      const x = padL + i * barW;
      // Same ramp as the congestion map: cool where the aisle flows, hot where
      // it stalls, so the two read as one family.
      const k = seconds / peak;
      const fill = `rgb(${Math.round(74 + k * 181)},${Math.round(158 - k * 61)},${Math.round(255 - k * 194)})`;
      return `<rect x="${x.toFixed(1)}" y="${(height - padB - h).toFixed(1)}" width="${Math.max(1, barW - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>`;
    })
    .join('');

  const ticks = [0, peak]
    .map((v, i) => {
      const y = i === 0 ? height - padB : height - padB - plot;
      return `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" fill="${LABEL}" font-size="${TYPE.micro}" text-anchor="end">${Math.round(v)}s</text>`;
    })
    .join('');

  return svg(
    width,
    height,
    bars +
      ticks +
      `<text x="${padL}" y="${height - 3}" fill="${LABEL}" font-size="${TYPE.micro}">nose</text>` +
      `<text x="${width - 8}" y="${height - 3}" fill="${LABEL}" font-size="${TYPE.micro}" text-anchor="end">tail</text>`,
  );
}

/** The three band breakdowns, as a compact table. */
export function equityBands(equity: Equity): string {
  const group = (title: string, bands: Equity['byZone']): string =>
    bands.length === 0
      ? ''
      : `<div class="band-group"><h4>${title}</h4>` +
        bands
          .map(
            (b) =>
              `<div class="band"><span>${b.label}</span>` +
              `<strong>${Math.round(b.meanWait)}s</strong>` +
              `<small>${b.count} pax</small></div>`,
          )
          .join('') +
        '</div>';

  return (
    '<div class="bands">' +
    group('By cabin zone', equity.byZone) +
    group('By seat', equity.byColumn) +
    group('By cohort', equity.byCohort) +
    '</div>'
  );
}
