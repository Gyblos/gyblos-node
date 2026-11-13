// Renderer-safe agent configuration metadata: environment references and model names, never credentials.
import {
  AGENT_SETUP,
  AGENT_TOOLS,
  type AgentTool,
} from '@gyblos/node/agent-setup-constants';
import { keyObject } from '@gyblos/protocol/buyer-api-keys';

import { USDC_AGENT_SETUP } from './x402/constants';

export interface AgentSetupPreview {
  tool: AgentTool;
  text: string;
  models: string[];
  path?: string;
  backup?: string;
}
export function parseAgentSetupPreview(input: unknown): AgentSetupPreview {
  const present = (field: string) =>
    input && typeof input === 'object' && Object.hasOwn(input, field);
  const row = keyObject(input, [
    'tool',
    'text',
    'models',
    ...(present('path') ? ['path'] : []),
    ...(present('backup') ? ['backup'] : []),
  ]);
  const tool = Object.values(AGENT_TOOLS).find((tool) => tool === row.tool);
  if (
    !tool ||
    typeof row.text !== 'string' ||
    row.text.length > USDC_AGENT_SETUP.maxTextCharacters ||
    !Array.isArray(row.models) ||
    !row.models.length ||
    row.models.length > AGENT_SETUP.maxModels ||
    !row.models.every(
      (id): id is string =>
        typeof id === 'string' && AGENT_SETUP.namePattern.test(id),
    )
  )
    throw new Error('Invalid agent configuration');
  for (const field of ['path', 'backup'])
    if (
      present(field) &&
      (typeof row[field] !== 'string' ||
        row[field].length > USDC_AGENT_SETUP.maxPathCharacters)
    )
      throw new Error('Invalid agent configuration');
  return {
    tool,
    text: row.text,
    models: row.models,
    ...(typeof row.path === 'string' ? { path: row.path } : {}),
    ...(typeof row.backup === 'string' ? { backup: row.backup } : {}),
  };
}
