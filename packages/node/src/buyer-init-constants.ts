// Guided buyer setup owns its new input bounds; selection file bounds are shared with the runtime.
export const BUYER_SELECTION_FILE = { maxBytes: 65_536 } as const;
export const BUYER_INIT_CODES = {
  INVALID: 'BUYER_INIT_INVALID',
  EXISTS: 'BUYER_INIT_EXISTS',
  UNAVAILABLE: 'BUYER_INIT_UNAVAILABLE',
} as const;
export const BUYER_INIT_LIMITS = { inputCharacters: 2048 } as const;
