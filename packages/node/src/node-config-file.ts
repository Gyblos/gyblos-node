// The one rule for which gyblos.toml the node reads: GYBLOS_CONFIG (relative to the working directory) when
// set, else ./gyblos.toml. An explicit file must exist and parse; the implicit one may be absent, which
// means no file. Seller startup, doctor, telemetry and the `gyblos` commands all read through here.
import { resolve } from 'node:path';

import { NODE_ENVIRONMENT, type HomeEnvironment } from '@gyblos/config';

import { NODE_CONFIG_FILENAME, NODE_CONFIG_ISSUE_CODES } from './constants';
import {
  readNodeConfigFile,
  type NodeConfig,
  type NodeConfigIssue,
} from './node-config';

export function nodeConfigPath(environment: HomeEnvironment, cwd: string) {
  const explicit = environment[NODE_ENVIRONMENT.config];
  return {
    path: resolve(cwd, explicit || NODE_CONFIG_FILENAME),
    explicit: Boolean(explicit),
  };
}

export type StartupConfigResult =
  | { ok: true; config: NodeConfig | undefined }
  | { ok: false; issues: NodeConfigIssue[] };

export async function readStartupConfig(
  environment: HomeEnvironment,
  cwd: string,
): Promise<StartupConfigResult> {
  const { path, explicit } = nodeConfigPath(environment, cwd);
  const read = await readNodeConfigFile(path);
  if (read.ok) return { ok: true, config: read.config };
  const missing =
    read.issues.length === 1 &&
    read.issues[0]!.code === NODE_CONFIG_ISSUE_CODES.FILE_NOT_FOUND;
  return missing && !explicit
    ? { ok: true, config: undefined }
    : { ok: false, issues: read.issues };
}
