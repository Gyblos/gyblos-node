// Accepts only an explicit real-engine opt-in; no configuration, index, home or endpoint overrides.
import {
  ACCEPTANCE_CODES,
  ACCEPTANCE_MODES,
  type AcceptanceMode,
} from './constants';
import { AcceptanceError } from './errors';

export function parseAcceptanceArgs(args: readonly string[]): {
  mode: AcceptanceMode;
} {
  if (!args.length) return { mode: ACCEPTANCE_MODES.SYNTHETIC };
  if (args.length === 1 && args[0] === '--real-ollama')
    return { mode: ACCEPTANCE_MODES.OLLAMA };
  throw new AcceptanceError(ACCEPTANCE_CODES.INVALID_OPTIONS);
}
