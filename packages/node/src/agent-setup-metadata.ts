// Conservative agent configuration and compatibility markers; neither is seller capacity evidence.
// Only validated models reach these pure helpers; hosts continue to own credentials and file writes.
import {
  AGENT_SETUP,
  AGENT_SETUP_CODES,
  CODEX_LEGACY_MARKS,
  CODEX_MARKS,
  type AgentModel,
} from './agent-setup-constants';

export class AgentSetupError extends Error {
  constructor(
    readonly code: (typeof AGENT_SETUP_CODES)[keyof typeof AGENT_SETUP_CODES],
  ) {
    super(code);
    this.name = 'AgentSetupError';
  }
}

export function agentModelDefaults(model: AgentModel): AgentModel {
  return model.contextTokens !== undefined
    ? model
    : {
        ...model,
        contextTokens: AGENT_SETUP.contextTokens,
        // Leave room for the prompt when the seller's actual input/output split is not known.
        maxOutputTokens: Math.min(
          model.maxOutputTokens,
          Math.floor(AGENT_SETUP.contextTokens / 2),
        ),
      };
}

export function codexStartMarker(text: string) {
  if (
    text.includes(CODEX_MARKS.start) &&
    text.includes(CODEX_LEGACY_MARKS.start)
  )
    throw new AgentSetupError(AGENT_SETUP_CODES.FILE);
  return text.includes(CODEX_MARKS.start)
    ? CODEX_MARKS.start
    : text.includes(CODEX_LEGACY_MARKS.start)
      ? CODEX_LEGACY_MARKS.start
      : CODEX_MARKS.start;
}
