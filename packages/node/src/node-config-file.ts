// The one rule for which gyblos.toml the node reads: GYBLOS_CONFIG (relative to the working directory) when
// set, else ./gyblos.toml (the packaged release: gyblos.toml in its home). An explicit file must exist and parse; the implicit one may be absent, which
// means no file. Seller startup, doctor, telemetry and the `gyblos` commands all read through here.
import { join, resolve } from 'node:path';

import {
  homeLayout,
  NODE_ENVIRONMENT,
  RUN_MODES,
  runMode,
  type HomeEnvironment,
} from '@gyblos/config';

import { NODE_CONFIG_FILENAME, NODE_CONFIG_ISSUE_CODES } from './constants';
import {
  readNodeConfigFile,
  type NodeConfig,
  type NodeConfigIssue,
} from './node-config';

export function nodeConfigPath(environment: HomeEnvironment, cwd: string) {
  const explicit = environment[NODE_ENVIRONMENT.config];
  // The packaged release keeps its implicit gyblos.toml in its home, wherever it is run from.
  const implicit =
    runMode(environment) === RUN_MODES.PACKAGED
      ? join(homeLayout(environment).root, NODE_CONFIG_FILENAME)
      : NODE_CONFIG_FILENAME;
  return {
    path: resolve(cwd, explicit || implicit),
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
