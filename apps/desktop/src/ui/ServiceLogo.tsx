// Local source-backed service marks shared by connection lists and chat menus.
// Unknown/custom tools retain a generic SVG icon rather than invented branding.
import { PlugsConnected } from '@phosphor-icons/react';

import { AGENT_CLIENT } from '../constants';

const SERVICE_MARKS: Record<string, { file: string; monochrome?: boolean }> = {
  [AGENT_CLIENT.CLAUDE_CODE]: { file: 'claudecode-color' },
  [AGENT_CLIENT.CODEX]: { file: 'codex', monochrome: true },
  [AGENT_CLIENT.OPENCODE]: { file: 'opencode', monochrome: true },
  [AGENT_CLIENT.PI]: { file: 'pi' },
  exa: { file: 'exa', monochrome: true },
  firecrawl: { file: 'firecrawl-color' },
  tinyfish: { file: 'tinyfish' },
};
export function ServiceLogo({ service }: { service: string }) {
  const mark = SERVICE_MARKS[service];
  return mark ? (
    <img
      className={`model-artwork${mark.monochrome ? ' monochrome' : ''}`}
      src={`./assets/tools/${mark.file}.svg`}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  ) : (
    <PlugsConnected size={16} aria-hidden="true" />
  );
}
