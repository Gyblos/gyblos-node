// Packages the built desktop app, unsigned, for one release target: macOS arm64 (zip of the .app), Windows
// x64 (zip) or Linux x64 (tar.gz, and a .deb where dpkg-deb exists). Any target builds on any host: Electron
// is downloaded for the target, and the target's native iroh binding comes from node_modules, verified by
// the lockfile (install with pnpm `supportedArchitectures` covering the target). Only built assets and that
// binding enter the package; no operational homes, logs, keys or repository source folders.
//
//   pnpm desktop:package                     # this machine's target
//   pnpm desktop:package -- --target win32-x64
//   GYBLOS_RELEASE_VERSION=0.1.0-beta.11 pnpm desktop:package -- --target linux-x64
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

import { packager } from '@electron/packager';

import {
  DESKTOP_PACKAGE,
  DESKTOP_TARGETS,
  type DesktopTarget,
} from './constants';
import { stageDesktopAssets } from './package-assets';

function chosenTarget(): DesktopTarget {
  const index = process.argv.indexOf('--target');
  const name =
    index >= 0
      ? process.argv[index + 1]
      : `${process.platform}-${process.arch}`;
  const target = DESKTOP_TARGETS.find((entry) => entry.name === name);
  if (!target)
    throw new Error(
      `Unsupported desktop target ${name}; use one of ${DESKTOP_TARGETS.map((entry) => entry.name).join(', ')}.`,
    );
  return target;
}

// A release version from the tag (without the leading v), else the app's own version.
function releaseVersion(own: string) {
  const version = process.env.GYBLOS_RELEASE_VERSION || own;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version))
    throw new Error('GYBLOS_RELEASE_VERSION must be a semantic version.');
  return version;
}

function hasDpkgDeb() {
  try {
    execFileSync('dpkg-deb', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const require = createRequire(import.meta.url);
const target = chosenTarget();
// The .app must be sealed again after packaging renames it, or macOS reports it as damaged; codesign
// exists only on macOS.
if (target.platform === 'darwin' && process.platform !== 'darwin')
  throw new Error(
    'Package darwin targets on macOS, where the app is signed ad hoc.',
  );
const manifest: { version: string; devDependencies: { electron: string } } =
  JSON.parse(await readFile('package.json', 'utf8'));
const version = releaseVersion(manifest.version);
const stage = resolve('dist/stage');
const packages = resolve('dist/packages');
const release = resolve('dist/release');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(release, { recursive: true });
await stageDesktopAssets('dist', stage);
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify({
    name: DESKTOP_PACKAGE.executable,
    productName: DESKTOP_PACKAGE.name,
    author: DESKTOP_PACKAGE.maintainer,
    version,
    main: 'main.cjs',
  }),
);
const sdk = dirname(require.resolve('@number0/iroh'));
const bindingName = `@number0/iroh-${target.binding}`;
let binding: string;
try {
  binding = dirname(
    require.resolve(`${bindingName}/package.json`, { paths: [sdk] }),
  );
} catch {
  throw new Error(
    `${bindingName} is not installed; install with pnpm supportedArchitectures covering ${target.name}.`,
  );
}
await mkdir(join(stage, 'node_modules/@number0'), { recursive: true });
await cp(sdk, join(stage, 'node_modules/@number0/iroh'), {
  recursive: true,
  dereference: true,
});
await cp(binding, join(stage, 'node_modules', bindingName), {
  recursive: true,
  dereference: true,
});

const [packaged] = await packager({
  dir: stage,
  out: packages,
  name:
    target.platform === 'darwin'
      ? DESKTOP_PACKAGE.name
      : DESKTOP_PACKAGE.executable,
  executableName: DESKTOP_PACKAGE.executable,
  appVersion: version,
  platform: target.platform,
  arch: target.arch,
  electronVersion: manifest.devDependencies.electron,
  appBundleId: DESKTOP_PACKAGE.bundleId,
  // Windows icons need rcedit (wine off Windows); macOS takes the .icns, Linux the .png in the .deb.
  ...(target.platform === 'darwin'
    ? { icon: resolve('resources/gyblos.icns') }
    : {}),
  asar: false,
  overwrite: true,
  prune: false,
});
if (!packaged) throw new Error('Electron packager produced no package.');
// Unsigned for distribution, but sealed ad hoc so Gatekeeper offers "Open" instead of "damaged".
if (target.platform === 'darwin') {
  const app = join(packaged, `${DESKTOP_PACKAGE.name}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], {
    stdio: 'inherit',
  });
}

const base = `gyblos-desktop-${version}-${target.name}`;
const outputs: string[] = [];
const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, stdio: 'inherit' });

// A minimal .deb: the app in /opt/Gyblos, a launcher in /usr/bin and a menu entry. chrome-sandbox must be
// setuid root for Electron's sandbox where unprivileged user namespaces are restricted (Ubuntu 24.04).
async function debian(app: string) {
  const root = resolve('dist/deb', base);
  await rm(root, { recursive: true, force: true });
  const installed = join(root, 'opt', DESKTOP_PACKAGE.name);
  await mkdir(dirname(installed), { recursive: true });
  await cp(app, installed, { recursive: true, verbatimSymlinks: true });
  await mkdir(join(root, 'usr/bin'), { recursive: true });
  await symlink(
    `/opt/${DESKTOP_PACKAGE.name}/${DESKTOP_PACKAGE.executable}`,
    join(root, 'usr/bin', DESKTOP_PACKAGE.executable),
  );
  await mkdir(join(root, 'usr/share/applications'), { recursive: true });
  await writeFile(
    join(
      root,
      'usr/share/applications',
      `${DESKTOP_PACKAGE.executable}.desktop`,
    ),
    [
      '[Desktop Entry]',
      `Name=${DESKTOP_PACKAGE.name}`,
      'Comment=Use AI models served by people on the Gyblos network',
      `Exec=${DESKTOP_PACKAGE.executable} %U`,
      `Icon=${DESKTOP_PACKAGE.executable}`,
      'Type=Application',
      'Categories=Utility;',
      '',
    ].join('\n'),
  );
  const icons = join(root, 'usr/share/icons/hicolor/512x512/apps');
  await mkdir(icons, { recursive: true });
  await cp(
    resolve('resources/gyblos.png'),
    join(icons, `${DESKTOP_PACKAGE.executable}.png`),
  );
  await mkdir(join(root, 'DEBIAN'), { recursive: true });
  await writeFile(
    join(root, 'DEBIAN/control'),
    [
      `Package: ${DESKTOP_PACKAGE.executable}`,
      // Debian sorts ~ first, so 0.1.0~beta.11 comes before 0.1.0.
      `Version: ${version.replace('-', '~')}`,
      'Architecture: amd64',
      `Maintainer: ${DESKTOP_PACKAGE.maintainer}`,
      'Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libxss1, libasound2 | libasound2t64, libgbm1',
      'Section: utils',
      'Priority: optional',
      `Description: ${DESKTOP_PACKAGE.name} desktop app`,
      ' Use AI models served by people on the Gyblos network.',
      '',
    ].join('\n'),
  );
  const postinst = join(root, 'DEBIAN/postinst');
  await writeFile(
    postinst,
    `#!/bin/sh\nset -e\nchown root:root /opt/${DESKTOP_PACKAGE.name}/chrome-sandbox\nchmod 4755 /opt/${DESKTOP_PACKAGE.name}/chrome-sandbox\n`,
  );
  await chmod(postinst, DESKTOP_PACKAGE.scriptMode);
  const output = join(release, `${base}.deb`);
  run('dpkg-deb', ['--root-owner-group', '--build', root, output], packages);
  return output;
}

if (target.platform === 'linux') {
  const archive = join(release, `${base}.tar.gz`);
  run('tar', ['-czf', archive, basename(packaged)], dirname(packaged));
  outputs.push(archive);
  if (hasDpkgDeb()) outputs.push(await debian(packaged));
} else {
  // -y keeps the macOS framework symlinks; Windows archives have none.
  const archive = join(release, `${base}.zip`);
  run('zip', ['-qry', archive, basename(packaged)], dirname(packaged));
  outputs.push(archive);
}
for (const output of outputs) {
  const digest = createHash('sha256')
    .update(await readFile(output))
    .digest('hex');
  await writeFile(`${output}.sha256`, `${digest}  ${basename(output)}\n`);
  process.stdout.write(`${output}\n`);
}
