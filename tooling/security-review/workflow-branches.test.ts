// Exercises the trusted workflow scripts against synthetic GitHub metadata only.
// No source checkout, model invocation, credential or GitHub request is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'c'.repeat(40);
const REPOSITORY = 'Gyblos/gyblos-node';

async function workflowScript(path: string, index: number): Promise<string> {
  const content = await readFile('.github/workflows/' + path, 'utf8');
  const blocks = [
    ...content.matchAll(
      /node --input-type=module <<'NODE'\n([\s\S]*?)\n\s*NODE/g,
    ),
  ];
  const block = blocks.at(index)?.[1];
  assert.ok(block);
  return block.replace(/^\s*import .+;\n/gm, '');
}

interface MetadataOptions {
  head?: string;
  repository?: string;
  completed?: boolean;
}

function exerciseScript(
  script: string,
  branch: string,
  options: MetadataOptions = {},
): { output: string; writes: string[][] } {
  const writes: string[][] = [];
  let output = '';
  const stopped = new Error('synthetic process exit');
  const pr = {
    state: 'open',
    base: { ref: branch, sha: BASE },
    head: {
      sha: options.head ?? HEAD,
      repo: { full_name: options.repository ?? REPOSITORY },
    },
    merge_commit_sha: MERGE,
  };
  const context = {
    process: {
      env: {
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_EVENT_PATH: '/synthetic/event',
        GITHUB_OUTPUT: '/synthetic/output',
        PR_NUMBER: '1',
        REQUEST_HEAD: HEAD,
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
      readFileSync: (path: string) =>
        path === '/synthetic/event'
          ? JSON.stringify({
              workflow_run: { head_sha: HEAD, pull_requests: [{ number: 1 }] },
            })
          : 'clean\n',
      appendFileSync: (_path: string, text: string) => {
        output += text;
      },
      lstatSync: () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: 6,
      }),
    },
    execFileSync: (_command: string, args: string[]) =>
      githubResponse(args, pr, options.completed ?? false, writes),
  };
  try {
    vm.runInNewContext(script, context);
  } catch (error: unknown) {
    if (error !== stopped) throw error;
  }
  return { output, writes };
}

function githubResponse(
  args: string[],
  pr: unknown,
  completed: boolean,
  writes: string[][],
): string {
  if (args.includes('POST') || args.includes('DELETE')) {
    writes.push(args);
    return '{}';
  }
  if (args.some((item) => item.includes('/comments'))) {
    return JSON.stringify([
      completed
        ? [
            {
              user: { login: 'github-actions[bot]' },
              body: `<!-- gyblos-ai-review:${HEAD}:${BASE}:${MERGE} -->`,
            },
          ]
        : [],
    ]);
  }
  return JSON.stringify(
    args.some((item) => item.endsWith('/labels')) ? [] : pr,
  );
}

for (const branch of ['develop', 'main']) {
  void test(`request binds an immutable same-repository PR into ${branch}`, async () => {
    const script = await workflowScript('ai-security-review.yml', 0);
    const result = exerciseScript(script, branch);
    assert.equal(
      result.output,
      `pr=1\nhead=${HEAD}\nmerge=${MERGE}\nbase=${BASE}\n`,
    );
    assert.deepEqual(result.writes, []);
  });

  void test(`publisher comments and labels the current ${branch} snapshot`, async () => {
    const script = await workflowScript('ai-security-review.yml', -1);
    const result = exerciseScript(script, branch);
    assert.equal(result.writes.length, 2);
    assert.ok(result.writes[0]?.includes('labels[]=ai-review:clean'));
    assert.ok(
      result.writes[1]?.some((arg) => arg.includes('AI source review:')),
    );
  });

  void test(`invalidator queues ${branch} and preserves its completed snapshot`, async () => {
    const script = await workflowScript('ai-review-state.yml', 0);
    const result = exerciseScript(script, branch);
    assert.equal(result.writes.length, 1);
    assert.ok(result.writes[0]?.includes('labels[]=ai-review:queued'));
    assert.deepEqual(
      exerciseScript(script, branch, { completed: true }).writes,
      [],
    );
  });

  void test(`all ${branch} scripts refuse forks and stale heads`, async () => {
    for (const script of [
      await workflowScript('ai-security-review.yml', 0),
      await workflowScript('ai-security-review.yml', -1),
      await workflowScript('ai-review-state.yml', 0),
    ]) {
      for (const options of [
        { repository: 'external/fork' },
        { head: 'd'.repeat(40) },
      ]) {
        assert.deepEqual(exerciseScript(script, branch, options), {
          output: '',
          writes: [],
        });
      }
    }
  });
}

void test('trusted scripts continue refusing unsupported target branches', async () => {
  for (const script of [
    await workflowScript('ai-security-review.yml', 0),
    await workflowScript('ai-security-review.yml', -1),
    await workflowScript('ai-review-state.yml', 0),
  ]) {
    assert.deepEqual(exerciseScript(script, 'feature/stack'), {
      output: '',
      writes: [],
    });
  }
});

void test('request and state events target develop and main', async () => {
  for (const path of ['ai-review-request.yml', 'ai-review-state.yml']) {
    const content = await readFile('.github/workflows/' + path, 'utf8');
    const branches = content.match(/branches:\s*\[([^\]]+)\]/)?.[1];
    assert.ok(branches);
    assert.deepEqual(
      branches
        .split(',')
        .map((branch) => branch.trim())
        .sort(),
      ['develop', 'main'],
    );
  }
});

void test('manual baseline follows the trusted repository default branch', async () => {
  const content = await readFile(
    '.github/workflows/ai-security-baseline.yml',
    'utf8',
  );
  assert.match(
    content,
    /if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
});
