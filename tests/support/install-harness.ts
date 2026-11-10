// install.sh against a fake `docker` (and, when given, a fake `cosign`) that records its arguments, for
// install-script*.test.ts. Offline.
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPOSITORY_ROOT } from './node-config-fixtures';

export const SCRIPT = join(REPOSITORY_ROOT, 'install.sh');
export const IMAGE = 'ghcr.io/gyblos/seller:test';
// Logs each call as one line; the compose version, doctor's output and result, config validation's
// result or an interrupt during it, and the result of `seller register` come from the environment.
const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$*" in
  'compose version --short') printf '%s\\n' "\${FAKE_COMPOSE_VERSION:-2.29.1}" ;;
  info) exit "\${FAKE_DOCKER_INFO_EXIT:-0}" ;;
  'compose run --rm seller gyblos doctor')
    [ -z "\${FAKE_DOCTOR_OUTPUT:-}" ] || printf '%s\\n' "$FAKE_DOCTOR_OUTPUT"
    exit "\${FAKE_DOCTOR_EXIT:-0}" ;;
  'compose run --rm seller gyblos config validate --config /config/gyblos.toml')
    # An operator's Ctrl-C while validation runs.
    [ -z "\${FAKE_VALIDATE_INTERRUPT:-}" ] || { kill -INT 0; sleep 1; }
    exit "\${FAKE_VALIDATE_EXIT:-0}" ;;
  'compose exec seller gyblos seller register') exit "\${FAKE_REGISTER_EXIT:-0}" ;;
esac
exit 0
`;

// Logs each verification; FAKE_COSIGN_EXIT makes it fail and FAKE_COSIGN_VERSION sets its version.
const FAKE_COSIGN = `#!/bin/sh
if [ "$1" = version ]; then
  printf 'GitVersion:    v%s\\n' "\${FAKE_COSIGN_VERSION:-3.1.4}"
  exit 0
fi
printf '%s\\n' "$*" >>"$FAKE_COSIGN_LOG"
exit "\${FAKE_COSIGN_EXIT:-0}"
`;

// Serves a release download from FAKE_RELEASE_DIR by its file name and logs each URL; FAKE_CURL_EXIT fails it.
const FAKE_CURL = `#!/bin/sh
out= url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\\n' "$url" >>"$FAKE_CURL_LOG"
# The machine's Ollama, for the packaged seller: FAKE_OLLAMA_EXIT makes it not answer.
case "$url" in http://127.0.0.1:11434/*) exit "\${FAKE_OLLAMA_EXIT:-0}" ;; esac
[ "\${FAKE_CURL_EXIT:-0}" = 0 ] || exit "$FAKE_CURL_EXIT"
cp "$FAKE_RELEASE_DIR/\${url##*/}" "$out"
`;

// `copy` runs a copy of install.sh in the temporary directory, for commands that replace the script.
export async function harness(
  options: { cosign?: boolean; curl?: boolean; copy?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-install-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  if (options.curl) {
    writeFileSync(join(bin, 'curl'), FAKE_CURL);
    chmodSync(join(bin, 'curl'), 0o755);
  }
  const script = options.copy ? join(root, 'install.sh') : SCRIPT;
  if (options.copy) copyFileSync(SCRIPT, script);
  if (options.cosign) {
    writeFileSync(join(bin, 'cosign'), FAKE_COSIGN);
    chmodSync(join(bin, 'cosign'), 0o755);
  }
  const cosignLog = join(root, 'cosign.log');
  const curlLog = join(root, 'curl.log');
  const release = join(root, 'release');
  mkdirSync(release);
  const directory = join(root, 'seller');
  const log = join(root, 'docker.log');
  const run = (env: Record<string, string> = {}, args: string[] = []) => {
    const options: SpawnSyncOptionsWithStringEncoding & { detached: boolean } =
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own session, so there is no controlling terminal to prompt on. spawnSync honors it, but its
        // options type omits it.
        detached: true,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: root,
          GYBLOS_DIR: directory,
          GYBLOS_IMAGE: IMAGE,
          FAKE_DOCKER_LOG: log,
          FAKE_COSIGN_LOG: cosignLog,
          FAKE_CURL_LOG: curlLog,
          FAKE_RELEASE_DIR: release,
          ...env,
        },
      };
    const result = spawnSync('sh', [script, ...args], options);
    return { ...result, output: result.stdout + result.stderr };
  };
  const calls = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  const signatureChecks = () => {
    try {
      return readFileSync(cosignLog, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  const downloads = () => {
    try {
      return readFileSync(curlLog, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  return {
    root,
    script,
    release,
    downloads,
    directory,
    run,
    calls,
    signatureChecks,
    file: (name: string) => readFileSync(join(directory, name), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
