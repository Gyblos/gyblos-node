// Turns the packaged seller archives (tooling/native-build.ts) into npm packages, the esbuild way: `gyblos`
// holds only a small wrapper and names one `@gyblos/seller-<target>` per platform as an optional
// dependency, so npm installs just this machine's. Each platform package is the archive's own folder: its
// launcher, its Node runtime and the bundle, so the seller never runs on the user's Node. npm never packs
// node_modules, so the iroh binding is a pinned dependency that npm installs instead.
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  archiveName,
  lockedPackage,
  NATIVE,
  TAR,
  type NativeTarget,
} from './native-build';

const run = promisify(execFile);
const REPOSITORY = resolve(import.meta.dirname, '..');

// npm's os and cpu names for each target.
const PLATFORMS: Readonly<
  Record<NativeTarget, { os: NodeJS.Platform; cpu: NodeJS.Architecture }>
> = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'linux-x64': { os: 'linux', cpu: 'x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64' },
  'win32-x64': { os: 'win32', cpu: 'x64' },
};

export const NPM = {
  main: 'gyblos',
  scope: '@gyblos',
  repository: 'https://github.com/Gyblos/gyblos-node',
  platforms: PLATFORMS,
} as const;

export const platformPackage = (target: NativeTarget) =>
  `${NPM.scope}/seller-${target}`;

// The wrapper npm links as `gyblos`. It runs on the user's Node only to find and start this machine's
// packaged seller. Ctrl-C at a terminal reaches the seller from the terminal itself; any other stop signal
// (a process manager, `timeout`) is passed on, and the seller's own exit or signal is the wrapper's. On
// Windows, where Node cannot start a .cmd without a shell, it runs the package's own node.exe with the
// environment gyblos.cmd would set.
export function wrapperScript(version: string) {
  const packages = Object.fromEntries(
    (Object.keys(NPM.platforms) as NativeTarget[]).map((target) => [
      target,
      platformPackage(target),
    ]),
  );
  return `#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const { dirname, join } = require('node:path');

const PACKAGES = ${JSON.stringify(packages)};
const OTHER = 'install it with Docker instead: curl -fsSL https://gyblos.com/install.sh -o install.sh && sh install.sh';
const fail = (text) => {
  process.stderr.write('gyblos: ' + text + '\\n');
  process.exit(1);
};
const VERSION = ${JSON.stringify(version)};
const target = process.platform + '-' + process.arch;
const name = PACKAGES[target];
if (!name) fail('there is no packaged seller for ' + target + '; ' + OTHER);
if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime)
  fail('the packaged seller needs glibc; ' + OTHER);
let root;
let manifest;
try {
  root = dirname(require.resolve(name + '/package.json'));
  manifest = require(name + '/package.json');
} catch {
  fail(name + ' is missing: reinstall with optional dependencies (npm install -g gyblos)');
}
if (manifest.version !== VERSION)
  fail(name + ' is ' + manifest.version + ', not ' + VERSION + ': reinstall (npm install -g gyblos@' + VERSION + ')');
const env = { ...process.env, GYBLOS_INSTALLED_BY: 'npm' };
let command = join(root, 'bin', 'gyblos');
let args = process.argv.slice(2);
if (process.platform === 'win32') {
  for (const key of Object.keys(env))
    if (/^(GYBLOS_CONTAINER|NODE_OPTIONS|NODE_PATH|NAPI_RS_NATIVE_LIBRARY_PATH)$/i.test(key)) delete env[key];
  Object.assign(env, {
    GYBLOS_PACKAGED: '1',
    GYBLOS_LAUNCHER: join(root, 'bin', 'gyblos.cmd'),
    GYBLOS_VERSION: VERSION,
  });
  command = join(root, 'runtime', 'node.exe');
  args = [join(root, 'lib', 'gyblos.mjs'), ...args];
}
const child = spawn(command, args, { stdio: 'inherit', env });
// At a terminal Ctrl-C already reaches the seller, which treats a second SIGINT as \"still stopping\".
const fromTerminal = process.stdin.isTTY;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => {
    if (signal !== 'SIGINT' || !fromTerminal) child.kill(signal);
  });
child.on('error', (error) => fail(error.message));
child.on('exit', (code, signal) => {
  if (!signal) process.exit(code ?? 1);
  process.removeAllListeners(signal);
  process.kill(process.pid, signal);
});
`;
}

const common = (version: string) => ({
  version,
  license: 'Apache-2.0',
  homepage: 'https://gyblos.com',
  repository: { type: 'git', url: `git+${NPM.repository}.git` },
});

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function mainPackage(
  version: string,
  targets: NativeTarget[],
  out: string,
) {
  const directory = join(out, NPM.main);
  await mkdir(join(directory, 'bin'), { recursive: true });
  await writeFile(join(directory, 'bin/gyblos.js'), wrapperScript(version));
  await copyFile(join(REPOSITORY, 'LICENSE'), join(directory, 'LICENSE'));
  await chmod(join(directory, 'bin/gyblos.js'), NATIVE.executableMode);
  await writeFile(
    join(directory, 'README.md'),
    `# gyblos\n\nThe Gyblos seller: sell your machine's AI inference peer to peer. \`npm install -g gyblos\`, then \`gyblos --help\`.\nSee ${NPM.repository}/blob/main/docs/running-a-node.md.\n`,
  );
  await writeJson(join(directory, 'package.json'), {
    name: NPM.main,
    ...common(version),
    description: 'The Gyblos seller node, packaged with its own Node runtime.',
    bin: { gyblos: 'bin/gyblos.js' },
    files: ['bin', 'README.md', 'LICENSE'],
    engines: { node: '>=18' },
    optionalDependencies: Object.fromEntries(
      targets.map((target) => [platformPackage(target), version]),
    ),
  });
  return directory;
}

async function platformDirectory(
  version: string,
  target: NativeTarget,
  archives: string,
  out: string,
) {
  const directory = join(out, `seller-${target}`);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await run(TAR, [
    '-xzf',
    join(archives, archiveName(version, target)),
    '-C',
    directory,
    '--strip-components=1',
  ]);
  // npm would drop it anyway; the binding comes from the dependency below.
  await rm(join(directory, 'lib/node_modules'), {
    recursive: true,
    force: true,
  });
  await copyFile(join(REPOSITORY, 'LICENSE'), join(directory, 'LICENSE'));
  const iroh = await lockedPackage(NATIVE.targets[target].iroh);
  await writeJson(join(directory, 'package.json'), {
    name: platformPackage(target),
    ...common(version),
    description: `The Gyblos seller for ${target}; installed by the gyblos package.`,
    os: [NPM.platforms[target].os],
    cpu: [NPM.platforms[target].cpu],
    // npm 10.4 and later then skips it on musl, where it cannot run.
    ...(NPM.platforms[target].os === 'linux' ? { libc: ['glibc'] } : {}),
    files: ['bin', 'lib', 'runtime', 'LICENSE'],
    dependencies: { [NATIVE.irohPackage]: iroh.version },
  });
  return directory;
}

export interface NpmBuild {
  version: string;
  targets: NativeTarget[];
  // Where the native archives are, as pnpm build:native wrote them.
  archives: string;
  out: string;
}

// Writes one folder per package and packs each with npm pack; returns the tarballs, platforms first.
// The unpacked folders are removed once packed, so only the tarballs are left in `out`.
export async function buildNpmPackages(build: NpmBuild) {
  // npm pack runs inside each package: its destination must not be relative.
  const options = {
    ...build,
    out: resolve(build.out),
    archives: resolve(build.archives),
  };
  await mkdir(options.out, { recursive: true });
  const directories = [];
  for (const target of options.targets)
    directories.push(
      await platformDirectory(
        options.version,
        target,
        options.archives,
        options.out,
      ),
    );
  directories.push(
    await mainPackage(options.version, options.targets, options.out),
  );
  const tarballs = [];
  for (const directory of directories) {
    const { stdout } = await run(
      'npm',
      ['pack', '--json', '--pack-destination', options.out],
      { cwd: directory },
    );
    const [packed] = JSON.parse(stdout) as { filename: string }[];
    tarballs.push(join(options.out, packed!.filename));
    await rm(directory, { recursive: true, force: true });
  }
  return tarballs;
}
