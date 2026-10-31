// Owns the portable repository-skill layout; it never invokes an agent or product code.
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const CANONICAL_SKILLS_ROOT = ['.agents', 'skills'] as const;
const CLAUDE_SKILLS_ROOT = ['.claude', 'skills'] as const;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillLayoutIssue {
  path: string;
  message: string;
}

export interface SkillLayoutReport {
  skills: string[];
  issues: SkillLayoutIssue[];
}

export interface MaterializeOptions {
  replace?: boolean;
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function pathLabel(root: string, path: string): string {
  return relative(root, path) || '.';
}

function canonicalRoot(root: string): string {
  return join(root, ...CANONICAL_SKILLS_ROOT);
}

function distributionRoot(root: string): string {
  return join(root, ...CLAUDE_SKILLS_ROOT);
}

function canonicalSkill(root: string, name: string): string {
  return join(canonicalRoot(root), name);
}

function distributionSkill(root: string, name: string): string {
  return join(distributionRoot(root), name);
}

async function directoryIssue(
  root: string,
  path: string,
  message: string,
  required: boolean,
): Promise<SkillLayoutIssue | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return { path: pathLabel(root, path), message };
    return undefined;
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    if (!required) return undefined;
    return { path: pathLabel(root, path), message };
  }
}

async function layoutRootIssues(root: string): Promise<SkillLayoutIssue[]> {
  const repositoryIssue = await directoryIssue(
    root,
    root,
    'Repository root must be a real directory.',
    true,
  );
  if (repositoryIssue) return [repositoryIssue];

  const canonicalParentIssue = await directoryIssue(
    root,
    join(root, '.agents'),
    'Canonical skills parent must be a real directory.',
    true,
  );
  if (canonicalParentIssue) return [canonicalParentIssue];

  const canonicalIssue = await directoryIssue(
    root,
    canonicalRoot(root),
    'Canonical skills root must be a real directory.',
    true,
  );
  if (canonicalIssue) return [canonicalIssue];

  const distributionParentIssue = await directoryIssue(
    root,
    join(root, '.claude'),
    'Claude skills parent must be a real directory.',
    false,
  );
  if (distributionParentIssue) return [distributionParentIssue];

  const distributionIssue = await directoryIssue(
    root,
    distributionRoot(root),
    'Claude skills root must be a real directory when present.',
    false,
  );
  return distributionIssue ? [distributionIssue] : [];
}

function expectedLinkTarget(root: string, name: string): string {
  const distribution = distributionSkill(root, name);
  const canonical = canonicalSkill(root, name);
  return relative(dirname(distribution), canonical).split(sep).join('/');
}

async function directoryEntries(
  path: string,
): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function canonicalSkillNames(
  root: string,
): Promise<{ names: string[]; issues: SkillLayoutIssue[] }> {
  const names: string[] = [];
  const issues: SkillLayoutIssue[] = [];
  const rootPath = canonicalRoot(root);
  const entries = await directoryEntries(rootPath);

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      issues.push({
        path: pathLabel(root, entryPath),
        message: 'Canonical skill entries must be real directories.',
      });
      continue;
    }
    if (!SKILL_NAME_PATTERN.test(entry.name)) {
      issues.push({
        path: pathLabel(root, entryPath),
        message: 'Skill directory name is not portable.',
      });
      continue;
    }
    const manifest = join(entryPath, 'SKILL.md');
    try {
      const manifestStat = await lstat(manifest);
      if (!manifestStat.isFile()) {
        issues.push({
          path: pathLabel(root, manifest),
          message: 'Every skill must contain a regular SKILL.md file.',
        });
        continue;
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      issues.push({
        path: pathLabel(root, manifest),
        message: 'Every skill must contain a SKILL.md file.',
      });
      continue;
    }
    names.push(entry.name);
  }

  names.sort();
  return { names, issues };
}

async function skillNamesAt(path: string): Promise<string[]> {
  const entries = await directoryEntries(path);
  const names = entries.map((entry) => entry.name).sort();
  return names;
}

async function skillFiles(path: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await skillFiles(entryPath, relativePath)));
      continue;
    }
    if (!entry.isFile())
      throw new Error(`Skill contains a non-regular file: ${relativePath}`);
    files.push(relativePath);
  }
  files.sort();
  return files;
}

async function materializedDifference(
  canonical: string,
  distribution: string,
): Promise<string | undefined> {
  try {
    const canonicalFiles = await skillFiles(canonical);
    const distributionFiles = await skillFiles(distribution);
    if (canonicalFiles.join('\0') !== distributionFiles.join('\0'))
      return 'file lists differ';
    for (const file of canonicalFiles) {
      const canonicalBytes = await readFile(join(canonical, file));
      const distributionBytes = await readFile(join(distribution, file));
      if (
        canonicalBytes.length !== distributionBytes.length ||
        canonicalBytes.some(
          (value, index) => value !== distributionBytes[index],
        )
      )
        return `file differs: ${file}`;
    }
    return undefined;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : 'unable to compare files';
  }
}

async function checkSkill(
  root: string,
  name: string,
): Promise<SkillLayoutIssue | undefined> {
  const distribution = distributionSkill(root, name);
  let distributionStat;
  try {
    distributionStat = await lstat(distribution);
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
    return {
      path: pathLabel(root, distribution),
      message: 'Claude skill mirror is missing.',
    };
  }

  if (distributionStat.isSymbolicLink()) {
    const actualTarget = await readlink(distribution);
    const expectedTarget = expectedLinkTarget(root, name);
    if (actualTarget !== expectedTarget)
      return {
        path: pathLabel(root, distribution),
        message: `Symlink target must be ${expectedTarget}.`,
      };
    return undefined;
  }

  if (!distributionStat.isDirectory())
    return {
      path: pathLabel(root, distribution),
      message: 'Claude skill mirror must be a symlink or directory.',
    };

  const difference = await materializedDifference(
    canonicalSkill(root, name),
    distribution,
  );
  if (difference)
    return {
      path: pathLabel(root, distribution),
      message: `Materialized skill differs: ${difference}.`,
    };
  return undefined;
}

export async function checkSkillLayout(
  root: string,
): Promise<SkillLayoutReport> {
  const rootIssues = await layoutRootIssues(root);
  if (rootIssues.length > 0) return { skills: [], issues: rootIssues };

  const canonical = await canonicalSkillNames(root);
  const issues = [...canonical.issues];
  if (canonical.names.length === 0 && canonical.issues.length === 0)
    issues.push({
      path: pathLabel(root, canonicalRoot(root)),
      message: 'Canonical skills root must contain at least one skill.',
    });
  const distributionNames = await skillNamesAt(distributionRoot(root));
  const canonicalSet = new Set(canonical.names);

  for (const name of distributionNames) {
    if (!canonicalSet.has(name))
      issues.push({
        path: pathLabel(root, distributionSkill(root, name)),
        message: 'Claude skill mirror has no canonical skill.',
      });
  }
  for (const name of canonical.names) {
    const issue = await checkSkill(root, name);
    if (issue) issues.push(issue);
  }

  return { skills: canonical.names, issues };
}

async function copySkill(
  canonical: string,
  distribution: string,
): Promise<void> {
  const files = await skillFiles(canonical);
  await mkdir(distribution, { recursive: true });
  for (const file of files) {
    const destination = join(distribution, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(canonical, file), destination);
  }
}

async function removeDistribution(
  path: string,
  stat: Awaited<ReturnType<typeof lstat>>,
): Promise<void> {
  if (stat.isSymbolicLink()) {
    await unlink(path);
    return;
  }
  await rm(path, { recursive: true, force: true });
}

export async function materializeSkills(
  root: string,
  options: MaterializeOptions = {},
): Promise<void> {
  const rootIssues = await layoutRootIssues(root);
  if (rootIssues.length > 0)
    throw new Error(rootIssues.map((issue) => issue.message).join('\n'));

  const canonical = await canonicalSkillNames(root);
  if (canonical.issues.length > 0)
    throw new Error(canonical.issues.map((issue) => issue.message).join('\n'));
  if (canonical.names.length === 0)
    throw new Error(
      `${pathLabel(root, canonicalRoot(root))}: Canonical skills root must contain at least one skill.`,
    );
  await mkdir(distributionRoot(root), { recursive: true });

  const canonicalSet = new Set(canonical.names);
  const staleNames = (await skillNamesAt(distributionRoot(root))).filter(
    (name) => !canonicalSet.has(name),
  );
  if (staleNames.length > 0 && !options.replace)
    throw new Error(
      `Refusing to replace stale Claude skill mirrors: ${staleNames.join(', ')}; rerun with --replace after reviewing them.`,
    );
  for (const name of staleNames) {
    const distribution = distributionSkill(root, name);
    const distributionStat = await lstat(distribution);
    await removeDistribution(distribution, distributionStat);
  }

  for (const name of canonical.names) {
    const distribution = distributionSkill(root, name);
    let distributionStat;
    try {
      distributionStat = await lstat(distribution);
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      await copySkill(canonicalSkill(root, name), distribution);
      continue;
    }

    if (distributionStat.isSymbolicLink()) {
      const actualTarget = await readlink(distribution);
      if (actualTarget === expectedLinkTarget(root, name)) continue;
    } else if (distributionStat.isDirectory()) {
      const difference = await materializedDifference(
        canonicalSkill(root, name),
        distribution,
      );
      if (!difference) continue;
    }

    if (!options.replace)
      throw new Error(
        `Refusing to replace ${pathLabel(root, distribution)}; rerun with --replace after reviewing it.`,
      );
    await removeDistribution(distribution, distributionStat);
    await copySkill(canonicalSkill(root, name), distribution);
  }
}
