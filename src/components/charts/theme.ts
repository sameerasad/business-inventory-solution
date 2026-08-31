/**
 * One source of truth for every chart on the dashboard, so the seven
 * visualizations read as a single system.
 *
 * Colour choices, and why:
 *  - Revenue and profit are the only two series that ever share a plot, so they
 *    take categorical slots 1 and 2 (blue, orange). That pair was validated
 *    against the white card surface: lightness band, chroma floor, protan/tritan
 *    separation (dE 24.7), normal-vision separation (dE 33.6) and 3:1 contrast all pass.
 *  - Single-measure breakdowns (packaging, volume, flavor, shop) are ONE series,
 *    so they are drawn in one hue. Colour there would encode nothing; length
 *    already carries the whole message.
 *  - Revenue and profit are both money, so the combo chart plots them on a
 *    single shared axis. No dual-axis charts anywhere.
 */

export const CHART = {
  revenue: "#2a78d6",
  profit: "#eb6834",
  /** Single-series breakdowns. */
  single: "#2a78d6",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  muted: "#898781",
  ink: "#0b0b0b",
  inkSecondary: "#52514e",
  surface: "#ffffff",
} as const;

/** Donut needs one colour per slice; two categories = slots 1 and 2. */
export const CATEGORY_COLORS = [CHART.revenue, CHART.profit, "#1baf7a", "#eda100", "#e87ba4"];

export const AXIS_TICK = { fill: CHART.muted, fontSize: 11 } as const;
export const AXIS_LINE = { stroke: CHART.axis } as const;

/** Rounded data-end anchored to the baseline: vertical and horizontal variants. */
export const RADIUS_VERTICAL: [number, number, number, number] = [4, 4, 0, 0];
export const RADIUS_HORIZONTAL: [number, number, number, number] = [0, 4, 4, 0];

export const MARGIN = { top: 8, right: 16, bottom: 4, left: 4 } as const;
