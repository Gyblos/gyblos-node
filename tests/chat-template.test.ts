// Checks that the chat renderer matches golden vectors from the pinned Jinja template and tokenizer config.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('chat renderer matches canonical pinned Jinja template golden vectors', async () => {
  const { createHash } = await import('node:crypto');
  const { MODEL, renderChat } = await import('@gyblos/engine-ollama/model');
  const config = await readFile('tests/fixtures/tokenizer_config.json', 'utf8');
  const vectors = JSON.parse(
    await readFile('tests/fixtures/chat-template-vectors.json', 'utf8'),
  );
  assert.equal(
    createHash('sha256').update(config).digest('hex'),
    MODEL.configSha256,
  );
  assert.equal(vectors.configSha256, MODEL.configSha256);
  assert.equal(vectors.cases.length, 3);
  // Expected strings were rendered independently with the pinned public Jinja template.
  for (const item of vectors.cases)
    assert.equal(renderChat(item.prompt), item.rendered);
});
