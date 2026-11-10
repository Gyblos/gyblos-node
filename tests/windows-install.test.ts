// Owns install.ps1 on real Windows (skipped elsewhere), against a local release server, a fake Ollama on
// 127.0.0.1:11434 and a fake packaged seller whose gyblos.cmd records its commands: a pinned release is
// downloaded, checked and unpacked into %LOCALAPPDATA%\Gyblos behind an app\current junction; the home is
// readable only by this account; gyblos.toml and seller.env are written once, without a byte order mark
// and without printing the relay token; setup, tokenizer, doctor (with seller.env) and the service run in
// order; a checksum mismatch changes nothing; and `publish` turns publishing on and restarts the service.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { ACL_VERDICTS, pathsArePrivate } from '@gyblos/runtime/windows-acl';

import { TAR } from '../tooling/native-build';
import { REPOSITORY_ROOT } from './support/node-config-fixtures';

const run = promisify(execFile);
const VERSION = '0.0.0-fake.1';
const NAME = `gyblos-${VERSION}-win32-x64`;
const OWNER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN = 'test-relay-token-for-the-installer-0123456789';
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const WINDOWS = process.platform === 'win32';

// Records each command; doctor needs seller.env's token and prints the owner as the real one does.
const FAKE_SELLER = [
  '@echo off',
  '>>"%GYBLOS_FAKE_LOG%" echo %*',
  'if "%1"=="doctor" (',
  '  if not defined GYBLOS_RELAY_TOKEN exit /b 1',
  '  echo READY',
  `  echo   owner  ${OWNER}`,
  ')',
  'exit /b 0',
  '',
].join('\r\n');

function listen(server: Server, port: number) {
  return new Promise<number>((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () =>
      done((server.address() as AddressInfo).port),
    );
  });
}

async function fixture(root: string) {
  const stage = join(root, 'stage');
  await mkdir(join(stage, NAME, 'bin'), { recursive: true });
  await writeFile(join(stage, NAME, 'bin', 'gyblos.cmd'), FAKE_SELLER);
  const releases = join(root, 'releases');
  await mkdir(releases);
  const archive = join(releases, `${NAME}.tar.gz`);
  await run(TAR, ['-czf', archive, '-C', stage, NAME]);
  await writeFile(`${archive}.sigstore.json`, '{}');
  const sha = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const files = createServer((request, response) => {
    const file = request.url?.replace(`/download/v${VERSION}/`, '') ?? '';
    readFile(join(releases, file)).then(
      (body) => response.end(body),
      () => {
        response.statusCode = 404;
        response.end();
      },
    );
  });
  const ollama = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(request.url === '/api/version' ? '{"version":"0.0.0"}' : '{}');
  });
  const port = await listen(files, 0);
  await listen(ollama, 11434);
  return {
    sha,
    url: `http://127.0.0.1:${port}`,
    close: () => {
      files.close();
      ollama.close();
    },
  };
}

async function pinned(root: string, sha: string) {
  const source = await readFile(join(REPOSITORY_ROOT, 'install.ps1'), 'utf8');
  const text = source
    .replace(/^\$NativeVersion = .*$/m, `$NativeVersion = '${VERSION}'`)
    .replace(/^\$NativeSha256 = .*$/m, `$NativeSha256 = '${sha}'`);
  const path = join(root, 'install.ps1');
  await writeFile(path, text);
  return path;
}

void test(
  'windows: install.ps1 installs a pinned release, writes the home once and starts the service',
  { skip: !WINDOWS, timeout: 300_000 },
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'gyblos-ps1-')));
    const server = await fixture(root);
    try {
      const account = join(root, 'account');
      const local = join(account, 'AppData', 'Local');
      await mkdir(local, { recursive: true });
      const log = join(root, 'commands.log');
      const installer = async (script: string, ...args: string[]) =>
        run(
          POWERSHELL,
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            ...args,
          ],
          {
            cwd: root,
            env: {
              SystemRoot: process.env.SystemRoot,
              PATH: process.env.PATH,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
              OS: 'Windows_NT',
              PATHEXT: process.env.PATHEXT,
              PROCESSOR_ARCHITECTURE: 'AMD64',
              USERPROFILE: account,
              LOCALAPPDATA: local,
              GYBLOS_RELEASE_URL: server.url,
              GYBLOS_RELAY_TOKEN: TOKEN,
              GYBLOS_GUIDED: '0',
              GYBLOS_MODIFY_PATH: '0',
              GYBLOS_FAKE_LOG: log,
            },
          },
        ).then(
          (result) => ({ code: 0, output: result.stdout + result.stderr }),
          (error: { code: number; stdout: string; stderr: string }) => ({
            code: error.code,
            output: error.stdout + error.stderr,
          }),
        );

      // A home made by hand that every user can read: the installer restricts it before seller.env.
      const home = join(account, '.gyblos');
      await mkdir(home, { recursive: true });
      await run(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
        [home, '/grant', '*S-1-5-32-545:(OI)(CI)R'],
      );
      assert.equal(await pathsArePrivate([home]), ACL_VERDICTS.EXPOSED);

      const wrong = await installer(await pinned(root, 'a'.repeat(64)));
      assert.equal(wrong.code, 1, wrong.output);
      assert.match(wrong.output, /does not match the checksum/);
      assert.deepEqual(
        await readdir(join(local, 'Gyblos', 'app')).catch(() => []),
        [],
      );

      const script = await pinned(root, server.sha);
      const first = await installer(script);
      assert.equal(first.code, 0, first.output);
      assert.ok(!first.output.includes(TOKEN));
      assert.match(first.output, new RegExp(`owner\\s+${OWNER}`));
      assert.match(first.output, /Next steps, to start selling/);
      assert.equal(
        await pathsArePrivate([home, join(home, 'seller.env')]),
        ACL_VERDICTS.PRIVATE,
      );
      const config = await readFile(join(home, 'gyblos.toml'));
      assert.notEqual(config[0], 0xef);
      assert.match(config.toString(), /^publish = false$/m);
      assert.ok(!config.toString().includes('\r'));
      assert.equal(
        await readFile(join(home, 'seller.env'), 'utf8'),
        `GYBLOS_RELAY_TOKEN=${TOKEN}\n`,
      );
      const app = join(local, 'Gyblos', 'app');
      assert.ok((await readdir(app)).includes(NAME));
      await readFile(join(app, 'current', 'bin', 'gyblos.cmd'));
      assert.match(
        await readFile(join(local, 'Gyblos', 'bin', 'gyblos.cmd'), 'utf8'),
        /app\\current\\bin\\gyblos\.cmd" %\*/,
      );
      const commands = (await readFile(log, 'utf8'))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.trim());
      assert.deepEqual(commands, [
        `setup --role seller --mint ${OWNER}`,
        'tokenizer',
        'doctor',
        'seller service uninstall',
        'seller service install',
      ]);

      // A rerun keeps the files and the release; publish turns it on and restarts the service.
      const again = await installer(script);
      assert.equal(again.code, 0, again.output);
      assert.match(again.output, /Kept existing .*gyblos\.toml/);
      await writeFile(log, '');
      const publish = await installer(script, 'publish');
      assert.equal(publish.code, 0, publish.output);
      assert.match(
        await readFile(join(home, 'gyblos.toml'), 'utf8'),
        /^publish = true$/m,
      );
      assert.deepEqual(
        (await readFile(log, 'utf8'))
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => line.trim().replace(/ --config .*/, ' --config')),
        [
          'config validate --config',
          'seller service uninstall',
          'seller service install',
        ],
      );
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
