import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const timeoutMs = 55000;
const sandbox = [
  '-p',
  '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))',
];

export async function isolatedOpenCode(
  endpoint: string,
  model: string,
  key: string,
) {
  const binary = process.env.OPENCODE_BIN;
  assert.ok(
    binary && isAbsolute(binary) && process.platform === 'darwin',
    'Use an absolute OPENCODE_BIN on macOS for the loopback sandbox',
  );
  const home = await mkdtemp(join(tmpdir(), 'gyblos-opencode-'));
  const config = join(home, 'opencode.json');
  const close = () => rm(home, { recursive: true, force: true });
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    TMPDIR: home,
    PATH: '/usr/bin:/bin',
    OPENCODE_CONFIG: config,
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_SHARE: 'true',
  };
  try {
    await writeFile(
      config,
      JSON.stringify({
        enabled_providers: ['gyblos'],
        model: 'gyblos/' + model,
        provider: {
          gyblos: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Gyblos',
            options: { baseURL: new URL('/v1', endpoint).href, apiKey: key },
            models: {
              [model]: { name: model, limit: { context: 64000, output: 64 } },
            },
          },
        },
        permission: { '*': 'deny' },
        agent: { build: { permission: { '*': 'deny' } } },
        tools: { '*': false },
      }),
      { mode: 0o600 },
    );
    const version = execFileSync(
      '/usr/bin/sandbox-exec',
      [...sandbox, binary, '--version'],
      {
        cwd: home,
        env,
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      },
    ).trim();
    let session = '';
    async function ask(prompt: string, expected: string) {
      const started = performance.now();
      const child = spawn(
        '/usr/bin/sandbox-exec',
        [
          ...sandbox,
          binary!,
          'run',
          '--standalone',
          '--format',
          'json',
          ...(session ? ['--session', session] : []),
          prompt,
        ],
        { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const done = once(child, 'close');
      child.stderr.resume();
      const deadline = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      let firstTextMs: number | undefined;
      let text = '';
      let finished = false;
      try {
        for await (const line of createInterface({ input: child.stdout })) {
          const event: unknown = JSON.parse(line);
          assert.ok(event && typeof event === 'object' && 'type' in event);
          if ('sessionID' in event && typeof event.sessionID === 'string') {
            if (session) assert.equal(event.sessionID, session);
            session = event.sessionID;
          }
          if (
            event.type === 'text' &&
            'part' in event &&
            event.part &&
            typeof event.part === 'object' &&
            'text' in event.part &&
            typeof event.part.text === 'string'
          ) {
            firstTextMs ??= Math.round(performance.now() - started);
            text += event.part.text;
          }
          if (event.type === 'step_finish') finished = true;
        }
        const [exit] = await done;
        assert.equal(exit, 0, 'OpenCode did not complete the paid turn');
        assert.ok(session && finished && firstTextMs !== undefined);
        assert.equal(text, expected);
        return firstTextMs;
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await done;
        }
      }
    }
    return { ask, version, close };
  } catch (error) {
    await close();
    throw error;
  }
}
