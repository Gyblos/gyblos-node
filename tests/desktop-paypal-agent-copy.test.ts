// Tests desktop agent copying with synthetic values and an injected clipboard.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { createDesktopPaypalAgentHandlers } from '@gyblos/desktop/paypal-agent-handlers';
import {
  claudeCodeConfig,
  claudeCodePowerShellConfig,
  codexConfig,
  opencodeConfig,
  PAYPAL_AGENT_CLIENT,
  PAYPAL_AGENT_COPY,
  PAYPAL_AGENT_USAGE_STATE,
  paypalAgentExample,
  piConfig,
  piSettings,
  type PaypalAgentUsageState,
} from '@gyblos/desktop/paypal-agent-model';

function fixture(failClipboard = false) {
  const contents = {};
  const frame = {};
  const writes: string[] = [];
  let loads = 0;
  let connected = true;
  let usage: PaypalAgentUsageState = PAYPAL_AGENT_USAGE_STATE.AVAILABLE;
  const connection = {
    url: 'http://127.0.0.1:12345/v1',
    key: 'synthetic-key',
    model: 'synthetic-model',
    spentCents: 0,
    limitCents: 100,
    keyLimitCents: 100,
    keySpentCents: 0,
    usageUncertain: false,
    disconnecting: false,
    usageState: PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
  };
  const access = {
    status: () =>
      connected
        ? {
            ...connection,
            usageState: usage,
            usageUncertain: usage !== PAYPAL_AGENT_USAGE_STATE.AVAILABLE,
            disconnecting: usage === PAYPAL_AGENT_USAGE_STATE.DISCONNECTING,
          }
        : null,
    async connect() {
      return connection;
    },
    copyKey(write: (text: string) => void) {
      write(connection.key);
      return true;
    },
    async disconnect() {},
    async close() {},
  };
  const handlers = createDesktopPaypalAgentHandlers(
    async () => {
      loads += 1;
      return { agentAccess: access };
    },
    { contents, mainFrame: () => frame, destroyed: () => false },
    () => ({ agentAccess: access }),
    (text: string) => {
      if (failClipboard) throw new Error('Synthetic clipboard failure');
      writes.push(text);
    },
  );
  return {
    handlers,
    connection,
    contents,
    frame,
    writes,
    loads: () => loads,
    disconnect: () => {
      connected = false;
    },
    setUsage: (value: PaypalAgentUsageState) => {
      usage = value;
    },
  };
}

void test('agent copying uses the existing connection and native clipboard', async () => {
  const f = fixture();
  const sender = { sender: f.contents, senderFrame: f.frame };
  for (const target of [
    PAYPAL_AGENT_COPY.KEY,
    PAYPAL_AGENT_CLIENT.OPENCODE,
    PAYPAL_AGENT_CLIENT.CODEX,
    PAYPAL_AGENT_CLIENT.PI,
    PAYPAL_AGENT_COPY.PI_SETTINGS,
    PAYPAL_AGENT_CLIENT.CLAUDE_CODE,
    PAYPAL_AGENT_COPY.CLAUDE_POWERSHELL,
  ])
    assert.equal(await f.handlers.copy(sender, [{ target }]), true);
  assert.deepEqual(f.writes, [
    f.connection.key,
    opencodeConfig(f.connection),
    codexConfig(f.connection),
    piConfig(f.connection),
    piSettings(),
    claudeCodeConfig(f.connection),
    claudeCodePowerShellConfig(f.connection),
  ]);
  assert.equal(f.loads(), 0);
});

void test('agent copying refuses a connection being revoked or no longer confirmed', async () => {
  const f = fixture();
  const sender = { sender: f.contents, senderFrame: f.frame };
  f.setUsage(PAYPAL_AGENT_USAGE_STATE.DISCONNECTING);
  assert.equal(
    await f.handlers.copy(sender, [{ target: PAYPAL_AGENT_COPY.KEY }]),
    false,
  );
  f.setUsage(PAYPAL_AGENT_USAGE_STATE.DISCONNECT_FAILED);
  assert.equal(
    await f.handlers.copy(sender, [{ target: PAYPAL_AGENT_COPY.KEY }]),
    false,
  );
  assert.deepEqual(f.writes, []);
});

void test('agent copying reports a native clipboard failure safely', async () => {
  const f = fixture(true);
  const sender = { sender: f.contents, senderFrame: f.frame };
  assert.equal(
    await f.handlers.copy(sender, [{ target: PAYPAL_AGENT_COPY.KEY }]),
    false,
  );
  assert.deepEqual(f.writes, []);
  assert.equal(f.loads(), 0);
});

void test('agent copying rejects foreign, malformed, or disconnected requests', async () => {
  const f = fixture();
  const sender = { sender: f.contents, senderFrame: f.frame };
  assert.equal(
    await f.handlers.copy({ sender: {}, senderFrame: f.frame }, [
      { target: PAYPAL_AGENT_COPY.KEY },
    ]),
    false,
  );
  assert.equal(
    await f.handlers.copy({ sender: f.contents, senderFrame: {} }, [
      { target: PAYPAL_AGENT_COPY.KEY },
    ]),
    false,
  );
  assert.equal(
    await f.handlers.copy(sender, [
      { target: PAYPAL_AGENT_COPY.KEY, extra: true },
    ]),
    false,
  );
  assert.equal(await f.handlers.copy(sender, [{ target: 'invalid' }]), false);
  assert.equal(await f.handlers.copy(sender, []), false);
  f.disconnect();
  assert.equal(
    await f.handlers.copy(sender, [{ target: PAYPAL_AGENT_COPY.KEY }]),
    false,
  );
  assert.deepEqual(f.writes, []);
  assert.equal(f.loads(), 0);
});

void test('standard API details copy independently without loading a session or exposing the key', async () => {
  const f = fixture();
  const sender = { sender: f.contents, senderFrame: f.frame };
  for (const target of [PAYPAL_AGENT_COPY.URL, PAYPAL_AGENT_COPY.MODEL])
    assert.equal(await f.handlers.copy(sender, [{ target }]), true);
  assert.deepEqual(f.writes, [f.connection.url, f.connection.model]);
  assert.equal(
    f.writes.some((text) => text.includes(f.connection.key)),
    false,
  );
  assert.equal(f.loads(), 0);
  f.disconnect();
  assert.equal(
    await f.handlers.copy(sender, [{ target: PAYPAL_AGENT_COPY.URL }]),
    false,
  );
});

void test('the generic API example keeps credentials in an environment variable', async () => {
  const f = fixture();
  const sender = { sender: f.contents, senderFrame: f.frame };
  assert.equal(
    await f.handlers.copy(sender, [{ target: PAYPAL_AGENT_COPY.EXAMPLE }]),
    true,
  );
  const text = f.writes[0]!;
  assert.ok(text.includes(`${f.connection.url}/chat/completions`));
  assert.ok(text.includes('Authorization: Bearer $GYBLOS_API_KEY'));
  assert.ok(text.includes(f.connection.model));
  assert.equal(text.includes(f.connection.key), false);
  assert.equal(f.loads(), 0);
});

void test('the API example is one shell-safe request with literal model data', () => {
  const model = "synthetic'$(printf unsafe)";
  const example = paypalAgentExample({
    url: 'http://127.0.0.1:12345/v1',
    model,
  });
  const script =
    'curl() { printf "%s\\n" "$@"; }; GYBLOS_API_KEY=synthetic-token;\n' +
    example;
  const args = execFileSync('bash', ['-c', script], { encoding: 'utf8' })
    .trim()
    .split('\n');
  assert.deepEqual(args, [
    'http://127.0.0.1:12345/v1/chat/completions',
    '--header',
    'Authorization: Bearer synthetic-token',
    '--header',
    'Content-Type: application/json',
    '--data',
    JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] }),
  ]);
});
