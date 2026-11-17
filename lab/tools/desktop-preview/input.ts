// Narrows synthetic renderer requests without trusting arbitrary object shapes.
export function requestObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : {};
}
