import { CaretRight } from '@phosphor-icons/react';

import { AGENT_CLIENT } from '../constants';
import { ServiceLogo } from './ServiceLogo';

export function AgentLogos() {
  return (
    <span className="preview-connect-logos" aria-hidden="true">
      {[
        AGENT_CLIENT.OPENCODE,
        AGENT_CLIENT.CODEX,
        AGENT_CLIENT.CLAUDE_CODE,
        AGENT_CLIENT.PI,
      ].map((tool) => (
        <span className="preview-tool-logo" key={tool}>
          <ServiceLogo service={tool} />
        </span>
      ))}
    </span>
  );
}
export function ConnectEntry({ open }: { open(): void }) {
  return (
    <button type="button" className="preview-connect-entry" onClick={open}>
      <AgentLogos />
      <span className="preview-connect-copy">
        <strong>Connect a dev tool</strong>
        <small>Use Gyblos models in OpenCode, Codex, Claude Code or Pi.</small>
      </span>
      <CaretRight size={14} aria-hidden="true" />
    </button>
  );
}
