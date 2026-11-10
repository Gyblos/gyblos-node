// seller.env, the service's private environment file: the relay token and API keys, read by systemd, the
// launch agent's shell or the Windows supervisor. Only lines all of them read the same way are accepted,
// and never a name the service sets itself or one that changes how the runtime loads code.
import {
  PrivateFileError,
  readPrivateFile,
} from '@gyblos/runtime/private-file';

import {
  SERVICE,
  SERVICE_ERRORS,
  SERVICE_RESERVED_PREFIXES,
  SERVICE_RESERVED_VARIABLES,
} from './constants';
import { ServiceError } from './service';

// Windows reads variable names without regard to case.
function reserved(name: string, windows: boolean) {
  const key = windows ? name.toUpperCase() : name;
  return (
    SERVICE_RESERVED_VARIABLES.some((variable) => variable === key) ||
    SERVICE_RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

// Only lines that systemd's EnvironmentFile and the launch agent's `set -a; . file` read identically:
// NAME=value with a non-empty value of printable characters and none that either expands, quotes,
// escapes or comments. Blank lines and whole-line comments are skipped. On Windows, where only the
// supervisor (service-run.ts) reads it, Notepad's CRLF line ends are accepted.
export function parseEnvironmentFile(
  source: string,
  windows = process.platform === 'win32',
) {
  const text = windows ? source.replaceAll('\r\n', '\n') : source;
  // systemd continues a line, even a comment, after a trailing backslash and ends one at a carriage return.
  if (/[\\\r]/.test(text))
    throw new ServiceError(SERVICE_ERRORS.ENVIRONMENT_INVALID);
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\x21-\x7e]+)$/.exec(line);
    if (!match || /["'`$\\#;|<>&(){}~]/.test(match[2]!))
      throw new ServiceError(SERVICE_ERRORS.ENVIRONMENT_INVALID);
    if (reserved(match[1]!, windows))
      throw new ServiceError(SERVICE_ERRORS.ENVIRONMENT_RESERVED);
    values[match[1]!] = match[2]!;
  }
  return values;
}

export async function readEnvironmentFile(path: string) {
  let text: string | undefined;
  try {
    // No symlink, owned by this account, mode 0600, bounded.
    text = await readPrivateFile(path, SERVICE.environmentMaxBytes);
  } catch (error) {
    if (error instanceof PrivateFileError)
      throw new ServiceError(SERVICE_ERRORS.ENVIRONMENT_UNREADABLE);
    throw error;
  }
  return text === undefined ? undefined : parseEnvironmentFile(text);
}
