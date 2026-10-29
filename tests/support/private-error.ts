// Shared privacy assertion for contract suites: a marker planted in upstream text or secret
// configuration must never reach an error, its stack, own properties or cause chain.
import assert from 'node:assert/strict';

export const UPSTREAM_MARKER = 'UPSTREAM-SECRET-MARKER';

export function assertPrivate(error: unknown): void {
  assert.ok(error instanceof Error);
  const seen = [
    error.message,
    String(error),
    error.stack ?? '',
    ...Object.getOwnPropertyNames(error).map((key) =>
      String(Reflect.get(error, key)),
    ),
  ];
  for (const text of seen) assert.ok(!text.includes(UPSTREAM_MARKER), text);
  if (error.cause !== undefined) assertPrivate(error.cause);
}
