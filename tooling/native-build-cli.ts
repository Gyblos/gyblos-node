// `pnpm build:native --version <semver> --target <darwin-arm64|linux-x64|linux-arm64>… [--out dir] [--node path]`
// builds the packaged seller archives; --node reuses this machine's Node for a build for this machine.
import { parseArgs } from 'node:util';

import { buildNative, hostTarget, isNativeTarget } from './native-build';

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    target: { type: 'string', multiple: true },
    out: { type: 'string', default: 'dist/native' },
    node: { type: 'string' },
  },
});
const version = values.version ?? '';
if (!VERSION.test(version)) throw new Error('--version takes a semver');
const targets = values.target ?? [hostTarget() ?? ''];
for (const target of targets) {
  if (!isNativeTarget(target))
    throw new Error(`unsupported target: ${target || 'this machine'}`);
  const built = await buildNative({
    version,
    target,
    out: values.out,
    ...(values.node ? { node: values.node } : {}),
  });
  console.log(`${built.sha256}  ${built.archive}`);
}
