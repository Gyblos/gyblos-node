// `pnpm build:npm --version <semver> [--target <target>]… [--archives dist/native] [--out dist/npm]` packs
// the npm packages from archives that pnpm build:native wrote for the same version.
import { parseArgs } from 'node:util';

import { isNativeTarget, NATIVE, type NativeTarget } from './native-build';
import { buildNpmPackages } from './npm-packages';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    target: { type: 'string', multiple: true },
    archives: { type: 'string', default: 'dist/native' },
    out: { type: 'string', default: 'dist/npm' },
  },
});
const targets = values.target ?? Object.keys(NATIVE.targets);
for (const target of targets)
  if (!isNativeTarget(target)) throw new Error(`unsupported target: ${target}`);
if (!values.version) throw new Error('--version is required');
for (const tarball of await buildNpmPackages({
  version: values.version,
  targets: targets as NativeTarget[],
  archives: values.archives,
  out: values.out,
}))
  console.log(tarball);
