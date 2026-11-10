// The packaged seller's launchers: the sh script for macOS and Linux and the cmd script for Windows. Both
// run the bundle on the package's own Node with only the package's own run mode and Node settings.
import { NATIVE } from './native-build';

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
exec "$root/${NATIVE.runtime}" "$root/${NATIVE.bundle}" "$@"
`;
}

// The Windows launcher: %~f0 keeps the app\current junction in its path, so a service keeps working across
// updates. cmd reads CRLF lines.
export function windowsLauncherScript(version: string) {
  const bundle = NATIVE.bundle.replaceAll('/', '\\');
  const runtime = NATIVE.windowsRuntime.replaceAll('/', '\\');
  return [
    '@echo off',
    `rem Gyblos seller ${version}: runs the bundled seller on its own Node runtime.`,
    'setlocal',
    'set "GYBLOS_PACKAGED=1"',
    'set "GYBLOS_LAUNCHER=%~f0"',
    `set "GYBLOS_VERSION=${version}"`,
    'rem Only this package decides its run mode, its Node options and where its modules come from.',
    'set "GYBLOS_CONTAINER="',
    'set "NODE_OPTIONS="',
    'set "NODE_PATH="',
    'set "NAPI_RS_NATIVE_LIBRARY_PATH="',
    `"%~dp0..\\${runtime}" "%~dp0..\\${bundle}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}
