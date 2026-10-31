// Owns portable repository-skill layout regressions; it never loads an agent.
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
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

async function withEmptyFixture(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'gyblos-skills-empty-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function symlinkUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!('code' in error)) return false;
  const code = error.code;
  return (
    typeof code === 'string' && ['EACCES', 'EPERM', 'ENOTSUP'].includes(code)
  );
}

async function createSkillSymlink(root: string): Promise<void> {
  const distribution = join(root, '.claude', 'skills', 'example-skill');
  const canonical = join(root, '.agents', 'skills', 'example-skill');
  await mkdir(dirname(distribution), { recursive: true });
  await symlink(
    relative(dirname(distribution), canonical).split(sep).join('/'),
    distribution,
    'dir',
  );
}

void test('accepts an exact relative symlink mirror', async (t) => {
  await withFixture(async (root) => {
    try {
      await createSkillSymlink(root);
    } catch (error: unknown) {
      if (!symlinkUnavailable(error)) throw error;
      t.skip('symlinks are unavailable in this checkout');
      return;
    }
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

void test('rejects a missing canonical skills root', async () => {
  await withEmptyFixture(async (root) => {
    const report = await checkSkillLayout(root);
    assert.equal(report.skills.length, 0);
    assert.match(report.issues[0]?.message ?? '', /Canonical skills parent/);
  });
});

void test('rejects an empty canonical skills root', async () => {
  await withEmptyFixture(async (root) => {
    await mkdir(join(root, '.agents', 'skills'), { recursive: true });
    const report = await checkSkillLayout(root);
    assert.match(report.issues[0]?.message ?? '', /at least one skill/);
  });
});

void test('rejects symlinked skill roots before materializing', async () => {
  await withFixture(async (root) => {
    const external = join(root, 'external-skills');
    const distribution = join(root, '.claude', 'skills');
    await mkdir(external, { recursive: true });
    await mkdir(dirname(distribution), { recursive: true });
    await symlink(external, distribution, 'dir');
    await assert.rejects(
      materializeSkills(root, { replace: true }),
      /Claude skills root must be a real directory/,
    );
    assert.equal((await readdir(external)).length, 0);
  });
});

void test('rejects a symlinked canonical skills parent before checking', async () => {
  await withFixture(async (root) => {
    const external = join(root, 'external-agents');
    const canonicalParent = join(root, '.agents');
    await mkdir(join(external, 'skills'), { recursive: true });
    await rm(canonicalParent, { recursive: true, force: true });
    await symlink(external, canonicalParent, 'dir');
    const report = await checkSkillLayout(root);
    assert.match(
      report.issues[0]?.message ?? '',
      /Canonical skills parent must be a real directory/,
    );
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

void test('reconciles stale materialized mirror entries explicitly', async () => {
  await withFixture(async (root) => {
    const stale = join(root, '.claude', 'skills', 'stale-skill');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'SKILL.md'), 'stale\n');
    const report = await checkSkillLayout(root);
    assert.match(report.issues[0]?.message ?? '', /no canonical skill/);
    await assert.rejects(materializeSkills(root), /stale Claude skill mirrors/);
    await materializeSkills(root, { replace: true });
    await assert.rejects(lstat(stale), /ENOENT/);
  });
});
