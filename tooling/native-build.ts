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
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
  // Bounds every download (200 MiB, 5 minutes); Node's archives are about 50 MB.
  maxDownloadBytes: 209_715_200,
  downloadTimeoutMs: 300_000,
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
root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -L)
GYBLOS_PACKAGED=1
GYBLOS_LAUNCHER=$root/${NATIVE.launcher}
GYBLOS_VERSION=${version}
export GYBLOS_PACKAGED GYBLOS_LAUNCHER GYBLOS_VERSION
# Only this package decides its run mode, its Node options and where its modules come from.
unset GYBLOS_CONTAINER NODE_OPTIONS NODE_PATH NAPI_RS_NATIVE_LIBRARY_PATH
# The npm package installs the binding from its registry package, whose manifest names a missing main.
exec "$root/${NATIVE.runtime}" --disable-warning=DEP0128 "$root/${NATIVE.bundle}" "$@"
`;
}

// Reads the body in chunks so the size bound holds without a Content-Length.
export async function download(url: string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(NATIVE.downloadTimeoutMs),
  });
  if (!response.ok || !response.body)
    throw new Error(`download failed: ${url}`);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.length;
    if (size > NATIVE.maxDownloadBytes) {
      await reader.cancel();
      throw new Error(`download too large: ${url}`);
    }
    chunks.push(Buffer.from(read.value));
  }
  return Buffer.concat(chunks);
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
    // Third-party license comments go to lib/gyblos.mjs.LEGAL.txt.
    legalComments: 'external',
    // CommonJS dependencies inside an ES module still call require for Node's built-ins.
    banner: {
      js: "import { createRequire as __gyblosRequire } from 'node:module'; const require = __gyblosRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
}

// Unpacks named members into a directory under the build's scratch directory, removed with it.
async function extract(scratch: string, archive: Buffer, members: string[]) {
  const directory = await mkdtemp(join(scratch, 'download-'));
  const file = join(directory, 'archive.tgz');
  await writeFile(file, archive);
  await run('tar', ['-xzf', file, '-C', directory, ...members]);
  return directory;
}

// A host build's Node must be the pinned release, copied as a file (never a link to this machine's).
async function hostNode(node: string) {
  const binary = await realpath(node);
  const { stdout } = await run(binary, ['--version']);
  if (stdout.trim() !== `v${NATIVE.nodeVersion}`)
    throw new Error(`--node must be Node ${NATIVE.nodeVersion}`);
  return binary;
}

async function stageNode(stage: string, target: NativeTarget, node?: string) {
  const runtime = join(stage, NATIVE.runtime);
  await mkdir(dirname(runtime), { recursive: true });
  if (node) {
    await cp(await hostNode(node), runtime);
  } else {
    const { node: platform, nodeSha256 } = NATIVE.targets[target];
    const name = `node-v${NATIVE.nodeVersion}-${platform}`;
    const archive = await download(
      `${NATIVE.nodeDist}/v${NATIVE.nodeVersion}/${name}.tar.gz`,
    );
    checkDigest(archive, 'sha256', nodeSha256, 'hex');
    const directory = await extract(dirname(stage), archive, [
      `${name}/bin/node`,
      `${name}/LICENSE`,
    ]);
    await cp(join(directory, name, 'bin/node'), runtime);
    await cp(join(directory, name, 'LICENSE'), `${dirname(runtime)}/LICENSE`);
  }
  await chmod(runtime, NATIVE.executableMode);
}

// What the binding's packages need at run time; their Rust sources and tests stay out.
const IROH_FILES = new Set([
  'package.json',
  'index.js',
  'index.d.ts',
  'README.md',
  'LICENSE',
]);
const irohFiles = (root: string) => (path: string) =>
  path === root || IROH_FILES.has(basename(path)) || path.endsWith('.node');

// The binding's loader, with its manifest's `main` pointed at the index.js it actually ships.
async function stageIrohLoader(modules: string) {
  const require = createRequire(
    join(REPOSITORY, 'packages/transport-iroh/package.json'),
  );
  const source = dirname(require.resolve(`${NATIVE.irohPackage}/package.json`));
  const destination = join(modules, NATIVE.irohPackage);
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: irohFiles(source),
  });
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
    await cp(installed, destination, {
      recursive: true,
      dereference: true,
      filter: irohFiles(installed),
    });
    return;
  }
  const locked = await lockedPackage(name);
  const archive = await download(
    `${NATIVE.registry}/@number0/${name}/-/${name}-${locked.version}.tgz`,
  );
  checkDigest(archive, 'sha512', locked.sha512, 'base64');
  const directory = await extract(dirname(stage), archive, ['package']);
  const unpacked = join(directory, 'package');
  await cp(unpacked, destination, {
    recursive: true,
    filter: irohFiles(unpacked),
  });
}

// GNU tar packs deterministically (sorted, fixed owner, time and modes), which a release requires; a
// local host build may use another tar.
async function pack(
  stage: string,
  root: string,
  archive: string,
  release: boolean,
) {
  const { stdout } = await run('tar', ['--version']);
  const gnu = stdout.includes('GNU tar');
  if (release && !gnu) throw new Error('a release build needs GNU tar');
  const deterministic = gnu
    ? [
        '--sort=name',
        '--mtime=@0',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '--mode=go-w',
      ]
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
    await pack(stage, name, archive, !options.node);
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
