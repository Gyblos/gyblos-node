// Builds the packaged seller release for one platform: a folder with its own Node runtime, one bundle of the
// seller and the iroh native binding, packed as gyblos-<version>-<target>.tar.gz. Every download is pinned:
// Node by the SHA-256 in NATIVE, iroh by the lockfile's integrity. A host build may reuse this machine's
// Node and installed binding instead of downloading them.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';

const run = promisify(execFile);
const REPOSITORY = resolve(import.meta.dirname, '..');

export const NATIVE = {
  nodeVersion: '24.22.1',
  nodeDist: 'https://nodejs.org/dist',
  registry: 'https://registry.npmjs.org',
  irohPackage: '@number0/iroh',
  entry: 'apps/node/src/bin.ts',
  bundle: 'lib/gyblos.mjs',
  launcher: 'bin/gyblos',
  runtime: 'runtime/node',
  executableMode: 0o755,
  // Bounds every download (200 MiB); Node's archives are about 50 MB.
  maxDownloadBytes: 209_715_200,
  targets: {
    'darwin-arm64': {
      node: 'darwin-arm64',
      nodeSha256:
        '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7',
      iroh: 'iroh-darwin-arm64',
    },
    'linux-x64': {
      node: 'linux-x64',
      nodeSha256:
        'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
      iroh: 'iroh-linux-x64-gnu',
    },
    'linux-arm64': {
      node: 'linux-arm64',
      nodeSha256:
        '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3',
      iroh: 'iroh-linux-arm64-gnu',
    },
  },
} as const;

export type NativeTarget = keyof typeof NATIVE.targets;

export const isNativeTarget = (value: string): value is NativeTarget =>
  Object.hasOwn(NATIVE.targets, value);

export const hostTarget = () => {
  const name = `${process.platform}-${process.arch}`;
  return isNativeTarget(name) ? name : undefined;
};

export const archiveName = (version: string, target: NativeTarget) =>
  `gyblos-${version}-${target}.tar.gz`;

// The launcher: follows the ~/.local/bin link to the installed bin/gyblos without resolving the
// app/current link, so a service keeps working across updates; then runs the bundle on its own Node.
export function launcherScript(version: string) {
  return `#!/bin/sh
# Gyblos seller ${version}: runs the bundled seller on its own Node runtime.
set -eu
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
root=$(cd "$(dirname "$self")/.." && pwd -L)
GYBLOS_PACKAGED=1
GYBLOS_LAUNCHER=$root/${NATIVE.launcher}
GYBLOS_VERSION=${version}
export GYBLOS_PACKAGED GYBLOS_LAUNCHER GYBLOS_VERSION
unset NODE_OPTIONS
exec "$root/${NATIVE.runtime}" "$root/${NATIVE.bundle}" "$@"
`;
}

export async function download(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${url}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > NATIVE.maxDownloadBytes)
    throw new Error(`download too large: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > NATIVE.maxDownloadBytes)
    throw new Error(`download too large: ${url}`);
  return bytes;
}

export function checkDigest(
  bytes: Buffer,
  algorithm: 'sha256' | 'sha512',
  expected: string,
  encoding: 'hex' | 'base64',
) {
  const actual = createHash(algorithm).update(bytes).digest(encoding);
  if (actual !== expected)
    throw new Error(`${algorithm} mismatch: expected ${expected}`);
}

// The lockfile's version and sha512 integrity for one iroh platform package.
export async function lockedPackage(name: string) {
  const lock = await readFile(join(REPOSITORY, 'pnpm-lock.yaml'), 'utf8');
  const match = new RegExp(
    `\\n  '@number0/${name}@([^']+)':\\n    resolution: \\{integrity: sha512-([A-Za-z0-9+/=]+)\\}`,
  ).exec(lock);
  if (!match) throw new Error(`@number0/${name} is not in pnpm-lock.yaml`);
  return { version: match[1]!, sha512: match[2]! };
}

async function bundle(stage: string) {
  await build({
    entryPoints: [join(REPOSITORY, NATIVE.entry)],
    outfile: join(stage, NATIVE.bundle),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // The native binding is loaded from lib/node_modules beside the bundle.
    external: [NATIVE.irohPackage],
    // CommonJS dependencies inside an ES module still call require for Node's built-ins.
    banner: {
      js: "import { createRequire as __gyblosRequire } from 'node:module'; const require = __gyblosRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
}

async function extract(archive: Buffer, members: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'gyblos-native-'));
  const file = join(directory, 'archive.tgz');
  await writeFile(file, archive);
  await run('tar', ['-xzf', file, '-C', directory, ...members]);
  return directory;
}

async function stageNode(stage: string, target: NativeTarget, node?: string) {
  const runtime = join(stage, NATIVE.runtime);
  await mkdir(dirname(runtime), { recursive: true });
  if (node) {
    await cp(node, runtime);
  } else {
    const { node: platform, nodeSha256 } = NATIVE.targets[target];
    const name = `node-v${NATIVE.nodeVersion}-${platform}`;
    const archive = await download(
      `${NATIVE.nodeDist}/v${NATIVE.nodeVersion}/${name}.tar.gz`,
    );
    checkDigest(archive, 'sha256', nodeSha256, 'hex');
    const directory = await extract(archive, [
      `${name}/bin/node`,
      `${name}/LICENSE`,
    ]);
    await cp(join(directory, name, 'bin/node'), runtime);
    await cp(join(directory, name, 'LICENSE'), `${dirname(runtime)}/LICENSE`);
    await rm(directory, { recursive: true, force: true });
  }
  await chmod(runtime, NATIVE.executableMode);
}

// The binding's loader, with its manifest's `main` pointed at the index.js it actually ships.
async function stageIrohLoader(modules: string) {
  const require = createRequire(
    join(REPOSITORY, 'packages/transport-iroh/package.json'),
  );
  const source = dirname(require.resolve(`${NATIVE.irohPackage}/package.json`));
  const destination = join(modules, NATIVE.irohPackage);
  await cp(source, destination, { recursive: true, dereference: true });
  const manifestPath = join(destination, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    main: string;
  };
  manifest.main = 'index.js';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return require;
}

async function stageIroh(stage: string, target: NativeTarget, host: boolean) {
  const modules = join(stage, 'lib/node_modules');
  const require = await stageIrohLoader(modules);
  const name = NATIVE.targets[target].iroh;
  const destination = join(modules, '@number0', name);
  if (host) {
    const loader = dirname(
      require.resolve(`${NATIVE.irohPackage}/package.json`),
    );
    const installed = dirname(
      createRequire(join(loader, 'index.js')).resolve(
        `@number0/${name}/package.json`,
      ),
    );
    await cp(installed, destination, { recursive: true, dereference: true });
    return;
  }
  const locked = await lockedPackage(name);
  const archive = await download(
    `${NATIVE.registry}/@number0/${name}/-/${name}-${locked.version}.tgz`,
  );
  checkDigest(archive, 'sha512', locked.sha512, 'base64');
  const directory = await extract(archive, ['package']);
  await cp(join(directory, 'package'), destination, { recursive: true });
  await rm(directory, { recursive: true, force: true });
}

// GNU tar packs deterministically (sorted, fixed owner and time); other tars pack plainly.
async function pack(stage: string, root: string, archive: string) {
  const { stdout } = await run('tar', ['--version']);
  const deterministic = stdout.includes('GNU tar')
    ? ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner']
    : [];
  await run('tar', [...deterministic, '-czf', archive, '-C', stage, root], {
    env: { ...process.env, GZIP: '-n' },
  });
}

export interface NativeBuild {
  version: string;
  target: NativeTarget;
  out: string;
  // This machine's Node binary, only for a host build.
  node?: string;
}

export async function buildNative(options: NativeBuild) {
  const host = options.target === hostTarget();
  if (options.node && !host)
    throw new Error('--node is only for a build for this machine');
  const name = `gyblos-${options.version}-${options.target}`;
  const stage = await mkdtemp(join(tmpdir(), 'gyblos-stage-'));
  const root = join(stage, name);
  try {
    await bundle(root);
    await stageNode(root, options.target, options.node);
    await stageIroh(root, options.target, host && Boolean(options.node));
    const launcher = join(root, NATIVE.launcher);
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, launcherScript(options.version));
    await chmod(launcher, NATIVE.executableMode);
    await mkdir(options.out, { recursive: true });
    const archive = join(
      options.out,
      archiveName(options.version, options.target),
    );
    await pack(stage, name, archive);
    const sha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    await writeFile(
      `${archive}.sha256`,
      `${sha256}  ${archiveName(options.version, options.target)}\n`,
    );
    return { archive, sha256 };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
