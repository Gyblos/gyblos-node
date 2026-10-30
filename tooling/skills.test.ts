// Owns portable repository-skill layout regressions; it never loads an agent.
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

import { checkSkillLayout, materializeSkills } from './skills';

const SKILL_CONTENT = `---
name: example-skill
description: Validate the example skill layout.
---

Use the repository rules.
`;

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-skills-'));
  const skillDirectory = join(root, '.agents', 'skills', 'example-skill');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'), SKILL_CONTENT);
  return root;
}

async function withFixture(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await createFixture();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createSkillSymlink(root: string): Promise<void> {
  const distribution = join(root, '.claude', 'skills', 'example-skill');
  const canonical = join(root, '.agents', 'skills', 'example-skill');
  await mkdir(dirname(distribution), { recursive: true });
  await symlink(
    relative(dirname(distribution), canonical),
    distribution,
    'dir',
  );
}

void test('accepts an exact relative symlink mirror', async () => {
  await withFixture(async (root) => {
    await createSkillSymlink(root);
    const report = await checkSkillLayout(root);
    assert.deepEqual(report.issues, []);
  });
});

void test('accepts a materialized mirror with identical files', async () => {
  await withFixture(async (root) => {
    await materializeSkills(root);
    const report = await checkSkillLayout(root);
    const distribution = join(
      root,
      '.claude',
      'skills',
      'example-skill',
      'SKILL.md',
    );
    const distributionStat = await lstat(dirname(distribution));
    assert.equal(distributionStat.isDirectory(), true);
    assert.equal(await readFile(distribution, 'utf8'), SKILL_CONTENT);
    assert.deepEqual(report.issues, []);
  });
});

void test('reports drift in a materialized mirror', async () => {
  await withFixture(async (root) => {
    const distribution = join(root, '.claude', 'skills', 'example-skill');
    await mkdir(distribution, { recursive: true });
    await writeFile(join(distribution, 'SKILL.md'), 'drifted\n');
    const report = await checkSkillLayout(root);
    assert.equal(report.issues.length, 1);
    assert.match(report.issues[0]?.message ?? '', /differs/);
  });
});

void test('requires explicit replacement before repairing a drifted mirror', async () => {
  await withFixture(async (root) => {
    await materializeSkills(root);
    const distribution = join(root, '.claude', 'skills', 'example-skill');
    await writeFile(join(distribution, 'SKILL.md'), 'drifted\n');
    await assert.rejects(materializeSkills(root), /after reviewing it/);
    await materializeSkills(root, { replace: true });
    assert.equal(
      await readFile(join(distribution, 'SKILL.md'), 'utf8'),
      SKILL_CONTENT,
    );
  });
});
