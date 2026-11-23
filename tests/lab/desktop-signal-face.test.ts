import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ui = new URL('../../apps/desktop/src/ui/', import.meta.url);
const source = (name: string) => readFile(new URL(name, ui), 'utf8');

void test('a pending desktop answer shows the animated bracketed face, and still honors reduced motion', async () => {
  const answer = await source('ChatAnswer.tsx');
  const progress = answer.slice(
    answer.indexOf('<AssistantProgress'),
    answer.indexOf('</AssistantProgress>'),
  );
  assert.match(progress, /<SignalFace\s/);
  assert.doesNotMatch(progress, /<SignalMark\s/);
  for (const state of ['CONNECTING', 'WORKING', 'RESPONDING'])
    assert.match(progress, new RegExp(`SIGNAL_STATE\\.${state}`));

  const face = await source('SignalFace.tsx');
  assert.match(face, /className="signal-mark signal-face"/);
  assert.match(face, /className="signal-brackets"/);
  assert.match(face, /data-working=\{working\}/);
  assert.match(face, /signal-orbit-left[\s\S]*signal-orbit-right/);

  const css = await source('signal.css');
  assert.match(
    css,
    /\.signal-face\[data-working='true'\] \.signal-orbit[^{]*\{[^}]*animation:/,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.signal-face,\s*\.signal-face \* \{\s*animation: none !important;/,
  );
  const motion = await source('motion.css');
  assert.match(motion, /svg:not\(\.nav-glyph\):not\(\.signal-mark\)/);
});
