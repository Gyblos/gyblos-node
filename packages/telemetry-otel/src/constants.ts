// Owns the adapter's fixed instrument catalog and bounded SDK settings; no lifecycle state.
export const OTEL_METRICS = {
  REQUESTS: 'gyblos.requests',
  COMPLETED: 'gyblos.completed',
  FAILED: 'gyblos.failed',
  REFUSED: 'gyblos.refused',
  UNSERVED: 'gyblos.unserved',
  INPUT_TOKENS: 'gyblos.input_tokens',
  OUTPUT_TOKENS: 'gyblos.output_tokens',
  REASONING_TOKENS: 'gyblos.reasoning_tokens',
  DELIVERED_OUTPUT_TOKENS: 'gyblos.delivered_output_tokens',
  FIRST_TOKEN: 'gyblos.first_token',
  DURATION: 'gyblos.duration',
} as const;
export type OtelMetricName = (typeof OTEL_METRICS)[keyof typeof OTEL_METRICS];
export const OTEL_SETTINGS = {
  scope: '@gyblos/telemetry-otel',
  cardinality: 128,
  operationTimeoutMs: 5000,
  latencyBoundaries: [0, 10, 50, 100, 250, 500, 1000, 5000, 10000, 60000],
} as const;
export const OTEL_ERROR_CODES = {
  EXPORT: 'TELEMETRY_OTEL_EXPORT_FAILED',
  TIMEOUT: 'TELEMETRY_OTEL_TIMEOUT',
} as const;
