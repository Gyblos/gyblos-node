// Owns the daily bar chart's axis policy: visible whole-number counts or hidden decimal amounts.
// Pure configuration, shared with the published board component.
export function barAxis(countAxis = true) {
  return { hide: !countAxis, allowDecimals: false };
}
