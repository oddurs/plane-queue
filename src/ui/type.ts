/**
 * The type scale, defined once.
 *
 * The app draws text in three places — the DOM, a canvas, and hand-built SVG —
 * and each had grown its own set of sizes. The DOM alone carried seven, five of
 * them inside a 2px band, which is five decisions doing one decision's work.
 *
 * Four sizes, each perceptibly different from its neighbour, each with a job:
 *
 *   micro    units, axis ticks, keycaps, in-drawing labels
 *   small    UI labels, table cells, secondary text
 *   base     body copy, controls, headings (weight carries the hierarchy)
 *   data     live values and measurements — the numbers being read
 *   display  the single largest figure on a surface
 *
 * The small end is deliberately tight and the data end opens up: labels should
 * cluster into texture, and the numbers they describe should separate from it.
 *
 * CSS mirrors these as custom properties. Canvas and SVG import them, so a
 * label in the cabin drawing is the same size as a label beside it in the DOM.
 */
export const TYPE = {
  micro: 11,
  small: 12,
  base: 13,
  data: 16,
  display: 20,
} as const;

export const WEIGHT = {
  /** Body copy and values. */
  regular: 400,
  /** Labels, and any value that should read as a figure rather than prose. */
  medium: 500,
  /** Headings. The only step above medium. */
  semibold: 600,
} as const;

/**
 * The interface stack. Canvas needs the family as a string; the DOM gets it
 * from the same constant so the two cannot drift apart.
 */
export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/** A canvas `font` shorthand at a scale step. */
export function canvasFont(size: number, weight: number = WEIGHT.regular): string {
  return `${weight} ${size}px ${FONT_STACK}`;
}
