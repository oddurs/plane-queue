import type { Congestion } from '../engine/types.ts';
import { TYPE } from '../ui/type.ts';

/**
 * Congestion heatmap: rows across, time downward.
 *
 * Rows run left-to-right so the columns line up with the cabin diagram above
 * it — a bright column means that row of the aisle was jammed, and reading down
 * the image replays when it happened.
 *
 * Note that a jam forms behind the passenger causing it, so congestion appears
 * forward of whoever is stowing. Back-to-front therefore lights up the front of
 * the cabin: that bright block is the queue tail backed up toward the door.
 */

/** Dark blue → amber → red, sampled at the cell's share of the peak value. */
function rampColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped < 0.5) {
    // Deep cerulean → amber: cool where the aisle flows, hot where it stalls.
    const k = clamped / 0.5;
    return `rgb(${Math.round(10 + k * 245)},${Math.round(61 + k * 136)},${Math.round(145 - k * 84)})`;
  }
  // Amber → signal red.
  const k = (clamped - 0.5) / 0.5;
  return `rgb(${Math.round(255)},${Math.round(197 - k * 105)},${Math.round(61 + k * 32)})`;
}

export function heatmapSvg(
  congestion: Congestion,
  width = 520,
  maxHeight = 190,
): string {
  const { rows, buckets, data, peak, bucketSeconds } = congestion;
  const padL = 34;
  const padB = 16;

  if (buckets === 0 || peak <= 0) {
    return (
      `<svg viewBox="0 0 ${width} 60" role="img">` +
      `<text x="${width / 2}" y="34" fill="#68738e" font-size="${TYPE.micro}" text-anchor="middle">` +
      `No aisle congestion recorded yet</text></svg>`
    );
  }

  const cellW = (width - padL - 8) / rows;
  // Height is fixed. Sizing the box to the bucket count made the SVG grow every
  // ten simulated seconds, so everything below it shifted down as the run
  // progressed — which reads as the whole page flickering.
  const height = maxHeight;
  const plot = height - padB - 12;
  const cellH = Math.max(1.5, Math.min(9, plot / Math.max(buckets, 1)));

  const cells: string[] = [];
  for (let b = 0; b < buckets; b++) {
    for (let r = 0; r < rows; r++) {
      const v = data[b * rows + r] ?? 0;
      if (v <= 0) continue;
      // Square-root scaling: linear scaling hides everything but the worst jam.
      cells.push(
        `<rect x="${(padL + r * cellW).toFixed(2)}" y="${(12 + b * cellH).toFixed(2)}" ` +
          `width="${(cellW + 0.5).toFixed(2)}" height="${(cellH + 0.5).toFixed(2)}" ` +
          `fill="${rampColor(Math.sqrt(v / peak))}"/>`,
      );
    }
  }

  // Time axis: a label every 60s of simulated time.
  const perMinute = Math.max(1, Math.round(60 / bucketSeconds));
  const ticks: string[] = [];
  for (let b = 0; b < buckets; b += perMinute) {
    const y = 12 + b * cellH;
    ticks.push(
      `<text x="${padL - 6}" y="${(y + 4).toFixed(1)}" fill="#68738e" font-size="${TYPE.micro}" ` +
        `text-anchor="end">${Math.round((b * bucketSeconds) / 60)}m</text>`,
    );
  }

  const labels =
    `<text x="${padL}" y="8" fill="#68738e" font-size="${TYPE.micro}">nose</text>` +
    `<text x="${width - 8}" y="8" fill="#68738e" font-size="${TYPE.micro}" text-anchor="end">tail</text>` +
    `<text x="${padL}" y="${height - 4}" fill="#68738e" font-size="${TYPE.micro}">` +
    `brightest cell: ${peak.toFixed(0)}s of blocking in one row over ${bucketSeconds}s</text>`;

  return (
    `<svg viewBox="0 0 ${width} ${height}" role="img" ` +
    `aria-label="Aisle congestion by row over time">` +
    cells.join('') +
    ticks.join('') +
    labels +
    `</svg>`
  );
}
