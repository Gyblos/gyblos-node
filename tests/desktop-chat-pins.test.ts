import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { desktopChatPaths } from '@gyblos/config/home-desktop';
import { projectChatArchive } from '@gyblos/desktop/chat-archive-model';
import { createChatArchiveStorage } from '@gyblos/desktop/chat-archive-storage';
import { ChatArchiveStore } from '@gyblos/desktop/chat-archive-store';

import { conversation, files } from './support/chat-archive-fixture';

void test('an unwritable pin file allows later transcript saves and deletions', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'gyblos-pin-failure-'));
  const storage = createChatArchiveStorage(profile);
  try {
    const loaded = await storage.store.load();
    const paths = desktopChatPaths(profile);
    await mkdir(paths.pins);
    const chat = conversation();
    const previous = chat.getSnapshot().activeId;
    chat.pinChat(previous, true);
    const save = (sequence: number) =>
      storage.store.save({
        generation: loaded.generation,
        sequence,
        archive: projectChatArchive(chat.getSnapshot()),
      });
    save(1);
    await storage.store.settled();
    assert.equal(storage.store.status().available, true);
    assert.equal(storage.store.status().pinsUnavailable, true);
    chat.deleteChat(previous, 'replacement');
    save(2);
    await storage.store.settled();
    assert.equal(storage.store.status().savedSequence, 2);
    assert.doesNotMatch(
      await readFile(paths.state, 'utf8'),
      /Synthetic answer/,
    );
  } finally {
    await storage.close();
    await rm(profile, { recursive: true, force: true });
  }
});

void test('editing a draft preserves existing pins when their initial read failed', async () => {
  const chat = conversation();
  const io = files();
  await io.write(JSON.stringify(projectChatArchive(chat.getSnapshot())));
  let storedPins: readonly string[] = [chat.getSnapshot().activeId];
  const store = new ChatArchiveStore({
    ...io,
    readPins: async () => {
      throw new Error('Pin metadata unavailable');
    },
    writePins: async (ids) => {
      storedPins = ids;
    },
  });
  const loaded = await store.load();
  chat.setDraft('Changed draft');
  store.save({
    generation: loaded.generation,
    sequence: 1,
    archive: projectChatArchive(chat.getSnapshot()),
  });
  await store.settled();
  assert.deepEqual(storedPins, [chat.getSnapshot().activeId]);
  assert.equal(store.status().pinsUnavailable, true);
  assert.match((await io.read()) ?? '', /Changed draft/);
  await store.close();
});

void test('a saved draft retains legacy embedded pins across a failed migration and restart', async () => {
  const chat = conversation();
  chat.pinChat(chat.getSnapshot().activeId, true);
  const io = files();
  await io.write(JSON.stringify(projectChatArchive(chat.getSnapshot())));
  const storage = {
    ...io,
    readPins: async () => [],
    writePins: async () => {
      throw new Error('Pin write unavailable');
    },
  };
  const store = new ChatArchiveStore(storage);
  const loaded = await store.load();
  chat.setDraft('Edited during migration');
  store.save({
    generation: loaded.generation,
    sequence: 1,
    archive: projectChatArchive(chat.getSnapshot()),
  });
  await store.close();
  const reopened = new ChatArchiveStore(storage);
  const session = (await reopened.load()).archive?.sessions[0];
  assert.equal(session?.draft, 'Edited during migration');
  assert.equal(session?.pinned, true);
  await reopened.close();
});
