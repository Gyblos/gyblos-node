// Local conversation persistence uses temporary files and synthetic text only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { desktopChatPaths } from '@gyblos/config/home';
import { createChatArchiveHandlers } from '@gyblos/desktop/chat-archive-handlers';
import {
  CHAT_STORAGE,
  parseChatArchive,
  projectChatArchive,
  restoreChatArchive,
} from '@gyblos/desktop/chat-archive-model';
import { createChatArchiveStorage } from '@gyblos/desktop/chat-archive-storage';
import { ChatArchiveStore } from '@gyblos/desktop/chat-archive-store';
import { ChatController } from '@gyblos/desktop/chat-controller';
import { MESSAGE_STATE } from '@gyblos/desktop/chat-state';
import { DEMO_AUTH } from '@gyblos/desktop/demo-account';
import { PAYMENT_METHOD } from '@gyblos/desktop/paypal-model';

import { conversation, files, model } from './support/chat-archive-fixture';

void test('conversation archive preserves draft, source, date and session link without runtime or credentials', () => {
  const chat = conversation();
  const archive = projectChatArchive(chat.getSnapshot());
  assert.ok(archive);
  const restored = restoreChatArchive(archive);
  assert.equal(restored.sessions[0]?.draft, 'Unsent draft');
  assert.equal(restored.sessions[0]?.messages[0]?.sentAt, 123);
  assert.equal(
    restored.sessions[0]?.messages[1]?.paymentMethod,
    PAYMENT_METHOD.PAYPAL,
  );
  assert.equal(
    restored.sessions[0]?.messages[1]?.paymentSessionId,
    'a'.repeat(64),
  );
  assert.equal(restored.sessions[0]?.paypalRun, null);
  assert.doesNotMatch(
    JSON.stringify(archive),
    /paypalRun|approval|authorization|captureId|apiKey|image|run/,
  );
});
void test('restoring unfinished responses cannot resume inference or claim completion', () => {
  const chat = conversation();
  chat.startPaypal('Unfinished paid question', model, 'pending');
  chat.newChat('preview');
  chat.start(
    'Preview question',
    model,
    [],
    'preview-run',
    () => DEMO_AUTH.APPROVED,
  );
  const archive = projectChatArchive(chat.getSnapshot());
  assert.ok(archive);
  const restored = restoreChatArchive(archive);
  assert.equal(
    restored.sessions[0]?.messages.at(-1)?.state,
    MESSAGE_STATE.FAILED,
  );
  assert.equal(
    restored.sessions[1]?.messages.at(-1)?.state,
    MESSAGE_STATE.STOPPED,
  );
  for (const session of restored.sessions) {
    assert.equal(session.run, null);
    assert.equal(session.paypalRun, null);
  }
});
void test('untrusted archives cannot add remote artwork, unknown tools, forged runtime or invalid timestamps', () => {
  const archive = projectChatArchive(conversation().getSnapshot())!;
  const first = archive.sessions[0]!;
  const message = first.messages[0]!;
  for (const patch of [
    {
      model: {
        ...message.model,
        image: { src: 'https://example.invalid/secret' },
      },
    },
    { tools: ['unknown'] },
    { sentAt: Number.MAX_SAFE_INTEGER },
    { paymentSessionId: 'PAYPAL_ORDER_SECRET' },
    { authorizationId: 'SECRET' },
  ])
    assert.equal(
      parseChatArchive({
        ...archive,
        sessions: [{ ...first, messages: [{ ...message, ...patch }] }],
      }),
      null,
    );
  assert.equal(
    parseChatArchive({ ...archive, sessions: [{ ...first, run: {} }] }),
    null,
  );
  assert.equal(parseChatArchive({ ...archive, activeId: 'absent' }), null);
  assert.equal(
    parseChatArchive({ ...archive, sessions: [first, first] }),
    null,
  );
});
void test('store writes only the newest accepted snapshot, survives restart and rejects stale writers', async () => {
  const io = files();
  const store = new ChatArchiveStore(io);
  const loaded = await store.load();
  const chat = conversation();
  assert.equal(
    store.save({
      generation: loaded.generation,
      sequence: 1,
      archive: projectChatArchive(chat.getSnapshot()),
    }).available,
    true,
  );
  chat.setDraft('Latest draft');
  store.save({
    generation: loaded.generation,
    sequence: 2,
    archive: projectChatArchive(chat.getSnapshot()),
  });
  await store.settled();
  assert.equal(store.status().savedSequence, 2);
  const next = await store.load();
  assert.equal(
    store.save({
      generation: loaded.generation,
      sequence: 99,
      archive: projectChatArchive(conversation().getSnapshot()),
    }).available,
    false,
  );
  assert.equal(next.archive?.sessions[0]?.draft, 'Latest draft');
  const restarted = new ChatArchiveStore(io);
  assert.equal(
    (await restarted.load()).archive?.sessions[0]?.draft,
    'Latest draft',
  );
});
void test('a damaged archive remains intact and cannot be replaced with a blank conversation', async () => {
  let writes = 0;
  const store = new ChatArchiveStore({
    read: async () => '{broken',
    write: async () => {
      writes++;
    },
  });
  const loaded = await store.load();
  assert.equal(loaded.available, false);
  assert.equal(
    store.save({
      generation: loaded.generation,
      sequence: 1,
      archive: projectChatArchive(conversation().getSnapshot()),
    }).available,
    false,
  );
  assert.equal(writes, 0);
});
void test('save accepts immediately while disk is pending and a write failure never claims saved', async () => {
  let reject: ((error: Error) => void) | undefined;
  const pending = new Promise<void>((_resolve, rejectWrite) => {
    reject = rejectWrite;
  });
  const store = new ChatArchiveStore({
    read: async () => undefined,
    write: async () => pending,
  });
  const loaded = await store.load();
  const accepted = store.save({
    generation: loaded.generation,
    sequence: 1,
    archive: projectChatArchive(conversation().getSnapshot()),
  });
  assert.equal(accepted.available, true);
  assert.equal(accepted.savedSequence, 0);
  reject?.(new Error('disk'));
  await store.settled();
  assert.equal(store.status().available, false);
  assert.equal(store.status().savedSequence, 0);
});
void test('only the owning main frame may read or write conversations', async () => {
  const store = new ChatArchiveStore(files());
  const contents = {};
  const frame = {};
  let destroyed = false;
  const handlers = createChatArchiveHandlers(store, {
    contents,
    mainFrame: () => frame,
    destroyed: () => destroyed,
  });
  const owner = { sender: contents, senderFrame: frame };
  assert.equal(
    (await handlers.load({ ...owner, senderFrame: {} }, [])).available,
    false,
  );
  assert.equal((await handlers.load(owner, [{}])).available, false);
  const loaded = await handlers.load(owner, []);
  assert.equal(loaded.available, true);
  destroyed = true;
  assert.equal(
    handlers.save(owner, [
      {
        generation: loaded.generation,
        sequence: 1,
        archive: projectChatArchive(conversation().getSnapshot()),
      },
    ]).available,
    false,
  );
});
void test('private local conversation file survives close and reopen with owner-only access', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'gyblos-chat-archive-'));
  const storage = createChatArchiveStorage(profile);
  try {
    const loaded = await storage.store.load();
    storage.store.save({
      generation: loaded.generation,
      sequence: 1,
      archive: projectChatArchive(conversation().getSnapshot()),
    });
    await storage.close();
    const paths = desktopChatPaths(profile);
    assert.match(await readFile(paths.state, 'utf8'), /Synthetic answer/);
    if (process.platform !== 'win32')
      assert.equal((await stat(paths.state)).mode & 0o777, 0o600);
    const reopened = createChatArchiveStorage(profile);
    assert.equal(
      (await reopened.store.load()).archive?.sessions[0]?.draft,
      'Unsent draft',
    );
    await reopened.close();
  } finally {
    await storage.close();
    await rm(profile, { recursive: true, force: true });
  }
});
void test('oversized messages fail validation without changing the saved archive', () => {
  const archive = projectChatArchive(conversation().getSnapshot())!;
  const first = archive.sessions[0]!;
  assert.equal(
    parseChatArchive({
      ...archive,
      sessions: [
        { ...first, draft: 'x'.repeat(CHAT_STORAGE.MAX_TEXT_CHARACTERS + 1) },
      ],
    }),
    null,
  );
});

void test('loading a new renderer freezes old writes until it receives a fresh generation', async () => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new ChatArchiveStore({
    read: async () => undefined,
    write: async () => waiting,
  });
  const first = await store.load();
  store.save({
    generation: first.generation,
    sequence: 1,
    archive: projectChatArchive(conversation().getSnapshot()),
  });
  const loading = store.load();
  assert.equal(
    store.save({
      generation: first.generation,
      sequence: 2,
      archive: projectChatArchive(conversation().getSnapshot()),
    }).available,
    false,
  );
  release?.();
  assert.equal((await loading).available, true);
});
void test('closing waits for an already started load and refuses subsequent writes', async () => {
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = new ChatArchiveStore({
    read: async () => {
      await waiting;
      return undefined;
    },
    write: async () => {},
  });
  const opening = store.load();
  let closed = false;
  const closing = store.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release?.();
  const loaded = await opening;
  await closing;
  assert.equal(loaded.available, false);
  assert.equal(store.status().available, false);
});

void test('pending preview prefixes survive restoration as stopped responses', () => {
  const chat = new ChatController('preview');
  chat.start('Question', model, [], 'preview-run', () => DEMO_AUTH.APPROVED);
  const snapshot = chat.getSnapshot();
  const session = snapshot.sessions[0]!;
  const archive = projectChatArchive({
    ...snapshot,
    sessions: [
      {
        ...session,
        messages: [
          session.messages[0]!,
          { ...session.messages[1]!, text: 'Already shown prefix' },
        ],
      },
    ],
  })!;
  const restored = restoreChatArchive(archive);
  assert.equal(restored.sessions[0]?.messages[1]?.text, 'Already shown prefix');
  assert.equal(restored.sessions[0]?.messages[1]?.state, MESSAGE_STATE.STOPPED);
});
