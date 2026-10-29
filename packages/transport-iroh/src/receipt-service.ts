// Injected receipt storage boundary; no runtime startup or engine access.
export function createReceiptService(_options: unknown): { respond(value: unknown, peer: string, signal: AbortSignal): Promise<unknown> } { throw new Error('Not implemented'); }
