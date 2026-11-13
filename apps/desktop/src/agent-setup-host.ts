// Main-process agent actions reuse the buyer CLI's generators and atomic writer.
// The renderer chooses a tool, never a file path, arbitrary configuration text or a secret.
import {
  AGENT_TOOLS,
  agentFilePath,
  type AgentEndpoint,
  type AgentTool,
} from '@gyblos/node/agent-setup';
import { agentText, writeAgentFile } from '@gyblos/node/agent-setup-host';

import type { AgentSetupPreview } from './agent-setup-model';
import { USDC_API_ACTION, type UsdcApiAction } from './x402/constants';

export interface AgentSetupFiles {
  home: string;
  environment: Readonly<NodeJS.ProcessEnv>;
}
export async function prepareAgentSetup(
  tool: AgentTool,
  endpoint: AgentEndpoint,
  action: UsdcApiAction,
  copy: (text: string) => void,
  files?: AgentSetupFiles,
): Promise<AgentSetupPreview> {
  const preview: AgentSetupPreview = {
    tool,
    text: agentText(tool, endpoint),
    models: endpoint.models.map((model) => model.id),
  };
  if (tool !== AGENT_TOOLS.CLAUDE_CODE && files)
    preview.path = agentFilePath(tool, files.home, files.environment);
  if (action === USDC_API_ACTION.COPY_AGENT) copy(preview.text);
  if (action === USDC_API_ACTION.WRITE_AGENT) {
    if (!files || tool === AGENT_TOOLS.CLAUDE_CODE)
      throw new Error('No file for this agent');
    const written = await writeAgentFile(
      tool,
      endpoint,
      files.home,
      files.environment,
    );
    return {
      ...preview,
      path: written.path,
      ...(written.backup !== undefined ? { backup: written.backup } : {}),
      ...(written.profiles !== undefined ? { profiles: written.profiles } : {}),
    };
  }
  return preview;
}
