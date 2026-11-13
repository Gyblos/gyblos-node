// Exercises hydration and autosave status through the real local client and synthetic bridge.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChatArchiveClient } from '@gyblos/desktop/chat-archive-client';
import {
  CHAT_STORAGE,
  CHAT_STORAGE_STATE,
  projectChatArchive,
  type ChatArchiveState,
} from '@gyblos/desktop/chat-archive-model';
import { ChatArchiveStore } from '@gyblos/desktop/chat-archive-store';
import { ChatController } from '@gyblos/desktop/chat-controller';
import { DEMO_AUTH } from '@gyblos/desktop/demo-account';

import { conversation, files, model } from './support/chat-archive-fixture';

void test('a delayed history restore blocks suggested drafts and sends until hydration completes', async () => {
  const chat = new ChatController('preview');
  const saved = projectChatArchive(conversation().getSnapshot())!;
  let resolve: ((archive: typeof saved) => void) | undefined;
  const pending = new Promise<typeof saved>((done) => {
    resolve = done;
  });
  const client = new ChatArchiveClient(
    chat,
    {
      load: async () => ({
        available: true,
        generation: 1,
        savedSequence: 0,
        archive: await pending,
      }),
      save: async (request) => ({
        available: true,
        generation: 1,
        savedSequence: request.sequence,
      }),
      status: async () => ({
        available: true,
        generation: 1,
        savedSequence: 0,
      }),
    },
    () => {},
  );
  try {
    const loading = client.start();
    chat.setDraft('Suggested prompt clicked during loading');
    let authorizations = 0;
    assert.equal(
      chat.start('Question', model, [], 'early', () => {
        authorizations++;
        return DEMO_AUTH.APPROVED;
      }),
      false,
    );
    chat.newChat('early-chat');
    assert.equal(chat.getSnapshot().sessions.length, 1);
    assert.equal(chat.getSnapshot().sessions[0]?.draft, '');
    assert.equal(authorizations, 0);
    resolve?.(saved);
    await loading;
    assert.equal(chat.getSnapshot().sessions[0]?.draft, 'Unsent draft');
    chat.setDraft('Suggested prompt after loading');
    assert.equal(
      chat.getSnapshot().sessions[0]?.draft,
      'Suggested prompt after loading',
    );
  } finally {
    client.close();
  }
});
void test('undoing an oversized draft recovers the saved indicator without another write', async () => {
  const store = new ChatArchiveStore(files());
  const chat = new ChatController('first');
  const states: ChatArchiveState[] = [];
  const client = new ChatArchiveClient(
    chat,
    {
      load: () => store.load(),
      save: async (request) => store.save(request),
      status: async () => store.status(),
    },
    (state) => states.push(state),
  );
  try {
    await client.start();
    chat.setDraft('Saved draft');
    await store.settled();
    await client.refresh();
    assert.equal(states.at(-1), CHAT_STORAGE_STATE.SAVED);
    const previous = store.status().savedSequence;
    chat.setDraft('x'.repeat(CHAT_STORAGE.MAX_TEXT_CHARACTERS + 1));
    assert.equal(states.at(-1), CHAT_STORAGE_STATE.UNAVAILABLE);
    chat.setDraft('Saved draft');
    assert.equal(states.at(-1), CHAT_STORAGE_STATE.SAVED);
    assert.equal(store.status().savedSequence, previous);
  } finally {
    client.close();
    await store.close();
  }
});
