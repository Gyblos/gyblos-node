// Owns trusted-workflow contract tests with mocked GitHub responses; no GitHub request is sent.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { REVIEW_FAILURE, REVIEW_PHASE } from './constants';

const WORKFLOW = resolve('.github/workflows/ai-security-review.yml');
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);

async function nodeBlock(index: number): Promise<string> {
  const workflow = await readFile(WORKFLOW, 'utf8');
  const blocks = [
    ...workflow.matchAll(
      /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/g,
    ),
  ];
  const code = blocks.at(index)?.[1];
  assert.ok(code);
  return code.replace(/^\s*import .+;\n/gm, '');
}
const publisher = () => nodeBlock(-1);
function runPublisher(
  code: string,
  base = BASE,
  merge = MERGE,
  diagnostics = '1\nunknown\n',
  status = 'clean',
  failedStep = '',
): string[][] {
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
          REVIEW_JOB_RESULT: failedStep ? 'failure' : 'success',
          FAILED_STEP: failedStep,
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
        readFileSync: (path: string) =>
          path.endsWith('diagnostics.txt') ? diagnostics : status,
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

void test('PR label write permission belongs to the invalidator job only', async () => {
  const content = await readFile(
    '.github/workflows/ai-review-state.yml',
    'utf8',
  );
  assert.match(
    content,
    /^permissions:\n  issues: write\n  pull-requests: read\n/m,
    'Keep the workflow default from granting PR write to other jobs.',
  );
  assert.match(
    content,
    /^  invalidate:\n    permissions:\n      issues: write\n      pull-requests: write\n/m,
    'The invalidator needs its own complete permission map to label PRs.',
  );
});

void test('publisher and invalidator serialize mutations under the same PR mutex', async () => {
  const publish = await readFile(WORKFLOW, 'utf8');
  const invalidate = await readFile(
    '.github/workflows/ai-review-state.yml',
    'utf8',
  );
  const group = (content: string) =>
    content
      .match(
        /group: (ai-review-label-[^\n]+)\n\s*cancel-in-progress: false/,
      )?.[1]
      ?.replaceAll('${{ needs.review.outputs.pr }}', '123')
      .replaceAll('${{ github.event.pull_request.number }}', '123');
  assert.ok(group(publish));
  assert.equal(group(publish), group(invalidate));
  assert.doesNotMatch(
    publish.slice(0, publish.indexOf('jobs:')),
    /cancel-in-progress: true/,
  );
});

void test('delayed invalidation preserves a completed result for the same snapshot', async () => {
  const content = await readFile(
    '.github/workflows/ai-review-state.yml',
    'utf8',
  );
  const block = [
    ...content.matchAll(
      /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/g,
    ),
  ][0]?.[1];
  assert.ok(block);
  const writes: string[][] = [];
  const stopped = new Error('exit');
  const pr = {
    state: 'open',
    base: { ref: 'main', sha: BASE },
    merge_commit_sha: MERGE,
    head: { sha: HEAD, repo: { full_name: 'Gyblos/gyblos-node' } },
  };
  try {
    vm.runInNewContext(block.replace(/^\s*import .+;\n/gm, ''), {
      process: {
        env: {
          GITHUB_REPOSITORY: 'Gyblos/gyblos-node',
          PR_NUMBER: '1',
          REQUEST_HEAD: HEAD,
        },
        exit: () => {
          throw stopped;
        },
      },
      execFileSync: (_command: string, args: string[]) => {
        if (args.includes('POST') || args.includes('DELETE')) {
          writes.push(args);
          return '{}';
        }
        if (args.some((item) => item.includes('/comments')))
          return JSON.stringify([
            [
              {
                user: { login: 'github-actions[bot]', type: 'Bot' },
                body:
                  '<!-- gyblos-ai-review:' +
                  HEAD +
                  ':' +
                  BASE +
                  ':' +
                  MERGE +
                  ' -->',
              },
            ],
          ]);
        if (args.some((item) => item.endsWith('/labels'))) return '[]';
        return JSON.stringify(pr);
      },
    });
  } catch (error: unknown) {
    if (error !== stopped) throw error;
  }
  assert.equal(writes.length, 0);
});

void test('publisher reports validated causes and rejects arbitrary diagnostic text', async () => {
  const code = await publisher();
  for (const [diagnostic, phrase] of [
    [
      'verify1 insufficient_quota',
      'First independent verification: OpenAI rejected',
    ],
    [
      'verify2 invalid_api_key',
      'Second independent verification: OpenAI authentication failed',
    ],
    ['review rate_limited', 'Source review: OpenAI rate-limited'],
    ['private-canary', 'failed to validate'],
  ]) {
    const writes = runPublisher(
      code,
      BASE,
      MERGE,
      '3\nunknown\n' + diagnostic,
      'error',
    );
    const comment = writes.flat().join(' ');
    assert.ok(comment.includes(phrase ?? ''));
    assert.doesNotMatch(comment, /private-canary/);
  }
  assert.match(
    runPublisher(code, BASE, MERGE, '', 'error', 'snapshot').flat().join(' '),
    /snapshot parent verification failed/,
  );
});

void test('publisher accepts every current diagnostic code and phase', async () => {
  const code = await publisher();
  for (const phase of Object.values(REVIEW_PHASE)) {
    const diagnostics = [
      '1',
      '10',
      ...Object.values(REVIEW_FAILURE).map((reason) => phase + ' ' + reason),
    ].join('\n');
    const writes = runPublisher(code, BASE, MERGE, diagnostics, 'error');
    assert.match(writes.flat().join(' '), /Reported tokens: 10/);
  }
});

// Runs the request binder against scripted PR reads; returns its outputs and how often it paused.
function runBinder(
  code: string,
  reads: readonly {
    merge: string | null;
    parents: readonly string[] | 'error';
  }[],
) {
  let read = 0;
  let pauses = 0;
  let output = '';
  const stopped = new Error('synthetic exit');
  try {
    vm.runInNewContext(code, {
      process: {
        env: {
          GITHUB_EVENT_PATH: 'event',
          GITHUB_REPOSITORY: 'Gyblos/gyblos-node',
          GITHUB_OUTPUT: 'out',
        },
        exit: () => {
          throw stopped;
        },
      },
      Atomics: {
        wait: () => {
          pauses++;
          return 'timed-out';
        },
      },
      Int32Array,
      SharedArrayBuffer,
      fs: {
        readFileSync: () =>
          JSON.stringify({
            workflow_run: { head_sha: HEAD, pull_requests: [{ number: 7 }] },
          }),
        appendFileSync: (_path: string, text: string) => {
          output += text;
        },
      },
      execFileSync: (_command: string, args: string[]) => {
        // A commit read belongs to the PR read just before it.
        const at = (args[1] ?? '').endsWith('/pulls/7') ? read : read - 1;
        const step = reads[Math.min(at, reads.length - 1)];
        if ((args[1] ?? '').endsWith('/pulls/7')) {
          read++;
          return JSON.stringify({
            state: 'open',
            base: { ref: 'develop', sha: BASE },
            merge_commit_sha: step?.merge,
            head: { sha: HEAD, repo: { full_name: 'Gyblos/gyblos-node' } },
          });
        }
        if (step?.parents === 'error') throw new Error('422');
        return JSON.stringify({
          parents: (step?.parents ?? []).map((sha) => ({ sha })),
        });
      },
    });
  } catch (error: unknown) {
    if (error !== stopped) throw error;
  }
  return { output, pauses, reads: read };
}

void test('the request binder waits for a merge snapshot of the current base and head', async () => {
  const code = await nodeBlock(0);
  const STALE = 'd'.repeat(40);
  const OLD_BASE = 'e'.repeat(40);
  const current = { merge: MERGE, parents: [BASE, HEAD] };
  for (const [name, reads, pauses, merge] of [
    [
      'stale, then current',
      [{ merge: STALE, parents: [OLD_BASE, HEAD] }, current],
      1,
      MERGE,
    ],
    [
      'still computing, then current',
      [{ merge: null, parents: [] }, current],
      1,
      MERGE,
    ],
    [
      'commit not served yet, then current',
      [{ merge: MERGE, parents: 'error' }, current],
      1,
      MERGE,
    ],
    [
      'stale until the wait runs out',
      [{ merge: STALE, parents: [OLD_BASE, HEAD] }],
      5,
      STALE,
    ],
  ] as const) {
    const result = runBinder(code, reads);
    assert.equal(result.pauses, pauses, name);
    assert.match(result.output, new RegExp('merge=' + merge), name);
    assert.match(result.output, new RegExp('base=' + BASE), name);
  }
});
