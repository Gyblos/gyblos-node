// Renders the shipped Activity screen with synthetic host snapshots, without a browser or services.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { before, test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { build } from 'esbuild';

import type { ActivityResult } from '@gyblos/desktop/activity-model';
import { emptyX402, type X402Record } from '@gyblos/desktop/x402-model';

let render: (state: ActivityResult | null, records: X402Record[]) => string;
before(async () => {
  const desktop = resolve('apps/desktop');
  const desktopRequire = createRequire(resolve(desktop, 'package.json'));
  const react = desktopRequire('react');
  const result = await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { Activity } from './src/ui/Activity';
        import { ChatController } from './src/ui/chat-controller';
        export function render(state, records) {
          return renderToStaticMarkup(createElement(Activity, {
            activity: { state, references: { available: true, references: [] },
              refresh: async () => state, copyReference: async () => false },
            x402: { state: { summary: { records }, policy: null } },
            chat: new ChatController('synthetic-chat'), selectedSession: null,
            onPayments() {}, onOpenChat() {}, onSelectSession() {}
          }));
        }`,
      resolveDir: desktop,
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
    jsx: 'automatic',
  });
  const module = { exports: { render } };
  runInNewContext(result.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: (name: string) =>
      name === 'react'
        ? {
            ...react,
            useSyncExternalStore: (
              _subscribe: unknown,
              snapshot: () => unknown,
            ) => snapshot(),
          }
        : desktopRequire(name),
  });
  render = module.exports.render;
});

const state: ActivityResult = {
  available: true,
  currentSessionId: null,
  sessions: [],
};
const record: X402Record = {
  id: 'synthetic-free-response',
  sessionId: 'synthetic-session',
  at: 1_700_000_000_000,
  free: true,
  chargeAtomic: '0',
  transaction: null,
  policy: {
    version: 1,
    policyId: '00000000-0000-4000-8000-000000000001',
    model: 'synthetic-model',
    maxTokens: 128,
    maxAtomic: '100',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    mint: '11111111111111111111111111111111',
    payer: '11111111111111111111111111111111',
  },
};

void test('free responses are activity even when there are no sandbox sessions', () => {
  const html = render(state, [record]);
  assert.ok(html.includes('Free response'));
  assert.equal(html.includes('No activity yet'), false);
});

void test('confirmed payments are activity even when there are no sandbox sessions', () => {
  const html = render(state, [{ ...record, free: false, chargeAtomic: '10' }]);
  assert.ok(html.includes('Confirmed payment'));
  assert.equal(html.includes('No activity yet'), false);
});

void test('an empty history still shows the activity empty state', () => {
  assert.ok(render(state, emptyX402().records).includes('No activity yet'));
});

void test('x402 records do not hide loading or unavailable session activity', () => {
  assert.ok(render(null, [record]).includes('Loading activity'));
  assert.ok(
    render({ ...state, available: false }, [record]).includes(
      'Activity unavailable',
    ),
  );
});
