// Owns the board components' canonical values: chart geometry, animated number formats and delta
// rounding. Shipped with the components in the registry (registry.json), so they stay self-contained.

// Daily charts.
export const CHART = {
  height: 176,
  // Above this many days the axis labels every other day.
  denseDays: 14,
  barRadius: 3,
  axisWidth: 44,
  tickFontSize: 10,
  topMargin: 4,
  // Room for the last day's axis label.
  rightMargin: 16,
  minTickGap: 20,
  // "MM-DD" from "YYYY-MM-DD".
  monthDayStart: 5,
} as const;

// Animated figures (NumberFlow): each kind's Intl format. USDC keeps up to its 6 decimals.
export const FLOW_FORMATS = {
  count: {},
  percent: { style: 'percent', maximumFractionDigits: 1 },
  usdc: {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  },
} as const;

export const DELTA = {
  percent: 100,
  // Decimal places of a change below 10%; larger changes are whole percents.
  smallDigits: 1,
  smallBelow: 10,
} as const;
