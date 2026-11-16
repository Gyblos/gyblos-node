// Owns trusted-workflow contract tests with mocked GitHub responses; no GitHub request is sent.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const WORKFLOW = resolve('.github/workflows/ai-security-review.yml');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);

async function publisher(): Promise<string> {
  const workflow = await readFile(WORKFLOW, 'utf8');
  const blocks = [
    ...workflow.matchAll(
      /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/g,
    ),
  ];
  const code = blocks.at(-1)?.[1];
  assert.ok(code);
  return code.replace(/^\s*import .+;\n/gm, '');
}
function runPublisher(code: string, base = BASE, merge = MERGE): string[][] {
  const writes: string[][] = [];
  const pr = {
    state: 'open',
    base: { ref: 'main', sha: base },
    merge_commit_sha: merge,
    head: { sha: HEAD, repo: { full_name: 'Gyblos/gyblos-node' } },
  };
  const stopped = new Error('synthetic exit');
  try {
    vm.runInNewContext(code, {
      process: {
        env: {
          GITHUB_REPOSITORY: 'Gyblos/gyblos-node',
          PR_NUMBER: '1',
          REVIEW_HEAD: HEAD,
          REVIEW_BASE: BASE,
          REVIEW_MERGE: MERGE,
          REVIEW_JOB_RESULT: 'success',
        },
        exit: () => {
          throw stopped;
        },
      },
      fs: {
        lstatSync: () => ({
          isFile: () => true,
          isSymbolicLink: () => false,
          size: 6,
        }),
        readFileSync: () => 'clean\n',
      },
      execFileSync: (_command: string, args: string[]) => {
        if (args.includes('POST') || args.includes('DELETE')) {
          writes.push(args);
          return '{}';
        }
        return JSON.stringify(
          args.some((item) => item.endsWith('/labels')) ? [] : pr,
        );
      },
    });
  } catch (error: unknown) {
    if (error !== stopped) throw error;
  }
  return writes;
}
void test('publisher refuses a different current base or merge snapshot', async () => {
  const code = await publisher();
  assert.equal(runPublisher(code, 'd'.repeat(40)).length, 0);
  assert.equal(runPublisher(code, BASE, 'e'.repeat(40)).length, 0);
  assert.equal(runPublisher(code).length, 2);
});
void test('Pi runtime lock pins registry integrity for every dependency', async () => {
  const lock = JSON.parse(
    await readFile('tooling/security-review/runtime/package-lock.json', 'utf8'),
  );
  for (const [path, raw] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.ok(typeof raw === 'object' && raw !== null);
    assert.ok(
      'integrity' in raw &&
        typeof raw.integrity === 'string' &&
        raw.integrity.startsWith('sha512-'),
      path,
    );
  }
});
void test('PR Pi installation prefix resolves to the committed runtime lockfile', async () => {
  const content = await readFile(WORKFLOW, 'utf8');
  assert.match(content, /working-directory: runner/);
  const prefix = content.match(/npm ci --prefix ([^\s]+)/)?.[1];
  assert.ok(prefix);
  await readFile(resolve(prefix, 'package-lock.json'), 'utf8');
});

void test('metadata-only label invalidation has no checkout or model credential', async () => {
  const content = await readFile(
    '.github/workflows/ai-review-state.yml',
    'utf8',
  );
  assert.match(content, /pull_request_target:/);
  assert.doesNotMatch(content, /actions\/checkout|OPENAI_API_KEY|npm |pnpm /);
  const block = [
    ...content.matchAll(
      /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/g,
    ),
  ][0]?.[1];
  assert.ok(block);
  new vm.Script(block.replace(/^\s*import .+;\n/gm, ''));
});
