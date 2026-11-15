// Pure Codex profile names and content checksums; hosts own configuration files and writes.
import { createHash } from 'node:crypto';

import {
  AGENT_SETUP,
  CODEX_MARKS,
  type AgentModel,
} from './agent-setup-constants';

// Content integrity for managed profiles; comments remain valid TOML and carry no secret material.
export function codexProfileText(text: string) {
  const digest = createHash('sha256').update(text).digest('hex');
  return text + CODEX_MARKS.profileDigest + digest + '\n';
}

// One profile name per model: its id with other characters as dashes, numbered when two ids collide.
// Names collide ignoring case: each is a file name, and macOS and Windows file systems would make
// `gyblos-Qwen3` and `gyblos-qwen3` one file.
export function profileNames(models: readonly AgentModel[]) {
  const used = new Set<string>([AGENT_SETUP.provider]);
  return models.map((model) => {
    const plain = `${AGENT_SETUP.provider}-${model.id.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`;
    let name = plain;
    for (let count = 2; used.has(name.toLowerCase()); count++)
      name = `${plain}-${count}`;
    used.add(name.toLowerCase());
    return name;
  });
}
