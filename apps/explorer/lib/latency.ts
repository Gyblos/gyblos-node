// Owns latency percentiles over the collector's fixed-bucket histograms: histograms are summed bucket
// by bucket, never averaged as percentiles. Pure functions, no I/O.
export interface Latency {
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  bucketsMs: number[];
  counts: number[];
}
// The upper bound (ms) of the bucket holding the percentile; 'above' past the last bound; null
// without samples.
export type LatencyBound = number | 'above' | null;

export function mergedLatency(
  parts: (Latency | null | undefined)[],
  share: number,
): LatencyBound {
  const present = parts.filter(
    (part): part is Latency => !!part && part.samples > 0,
  );
  const first = present[0];
  if (!first) return null;
  const counts = first.counts.map((_, index) =>
    present.reduce((sum, part) => sum + (part.counts[index] ?? 0), 0),
  );
  const samples = counts.reduce((sum, value) => sum + value, 0);
  let seen = 0;
  for (const [index, value] of counts.entries()) {
    seen += value;
    if (seen >= samples * share) return first.bucketsMs[index] ?? 'above';
  }
  return 'above';
}
