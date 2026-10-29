// Receipt persistence and integration entry points; no import-time I/O or runtime startup.
export function openReceiptStore(_options: unknown): { put(value: unknown,signal?:AbortSignal):Promise<void>; load(key:unknown,signal:AbortSignal):Promise<unknown>; confirm(value:unknown,signal:AbortSignal):Promise<boolean> } { throw new Error('Not implemented'); }
