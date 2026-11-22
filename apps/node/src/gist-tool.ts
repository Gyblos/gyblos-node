// Owns the optional GitHub CLI (`gh`) step of `gyblos seller verify github`: which account gh is signed in
// as, and creating one public gist. gh runs with a fixed argv, no shell, a timeout and bounded output; the
// gist text goes through a file in a fresh private temporary directory that is removed afterwards. The
// same calls work on Windows, macOS and Linux. Tests replace this module's tool.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FILE_MODES } from '@gyblos/config';

import { VERIFY_GITHUB } from './constants';

export interface GistTool {
  // The GitHub login gh is signed in as (lowercase), or undefined when gh is missing or signed out.
  login(): Promise<string | undefined>;
  // Creates a public gist holding `content`; resolves the gist's web URL as gh prints it.
  create(content: string): Promise<string>;
}

function gh(args: readonly string[]) {
  return new Promise<string>((done, fail) => {
    execFile(
      'gh',
      [...args],
      {
        timeout: VERIFY_GITHUB.ghTimeoutMs,
        maxBuffer: VERIFY_GITHUB.ghOutputCharacters,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => (error ? fail(error) : done(stdout)),
    );
  });
}

export const githubCli: GistTool = {
  async login() {
    try {
      const login = (await gh(['api', 'user', '--jq', '.login'])).trim();
      return login ? login.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  },
  async create(content) {
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-gist-'));
    try {
      const file = join(directory, VERIFY_GITHUB.gistFile);
      await writeFile(file, content, { mode: FILE_MODES.privateFile });
      const output = await gh([
        'gist',
        'create',
        '--public',
        '--desc',
        VERIFY_GITHUB.gistDescription,
        file,
      ]);
      return output.trim().split(/\r?\n/).pop() ?? '';
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
};
