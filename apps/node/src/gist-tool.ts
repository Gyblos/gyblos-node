// Owns the optional GitHub CLI (`gh`) step of `gyblos seller verify github`: which account gh is signed in
// as, finding a public gist by its description, and creating one public gist. gh runs with a fixed argv, no shell, a timeout and bounded output; the
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
  // The id of the signed-in account's public gist with exactly this description, if any.
  find(description: string): Promise<string | undefined>;
  // Creates a public gist holding `content` with `description`; resolves its web URL as gh prints it.
  create(content: string, description: string): Promise<string>;
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
  // `gh gist list` prints one gist per line: id, description, files, visibility and time, tab-separated.
  async find(description) {
    let output: string;
    try {
      output = await gh([
        'gist',
        'list',
        '--public',
        '--limit',
        String(VERIFY_GITHUB.ghListLimit),
      ]);
    } catch {
      return undefined;
    }
    for (const row of output.split(/\r?\n/)) {
      const [id, text] = row.split('\t');
      if (id && text === description) return id.toLowerCase();
    }
    return undefined;
  },
  async create(content, description) {
    const directory = await mkdtemp(join(tmpdir(), 'gyblos-gist-'));
    try {
      const file = join(directory, VERIFY_GITHUB.gistFile);
      await writeFile(file, content, { mode: FILE_MODES.privateFile });
      const output = await gh([
        'gist',
        'create',
        '--public',
        '--desc',
        description,
        file,
      ]);
      return output.trim().split(/\r?\n/).pop() ?? '';
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
};
