// Exercises provider admission and diagnostic privacy without external requests.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { writeArtifacts } from './artifacts';
import { REVIEW_FAILURE, REVIEW_VALUES, REVIEWER_IDS } from './constants';
import { repositoryRef } from './git';
import { runPi } from './pi';
import { buildBaselinePlan } from './plan';
import { runReview } from './runner';
import { FILE, FINDING, fixture, hunter, success } from './test-fixture';

for (const code of [REVIEW_FAILURE.QUOTA, REVIEW_FAILURE.KEY]) {
  void test('provider stop prevents new Pi calls for ' + code, async () => {
    await fixture(async (root, output) => {
      const script = join(output, 'synthetic.mjs');
      await writeFile(
        script,
        'for await (const _ of process.stdin) {}\n' +
          "console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:" +
          JSON.stringify(code + ' PRIVATE_CANARY') +
          '}}));',
      );
      const plan = buildBaselinePlan([FILE], await repositoryRef(root));
      const result = await runReview(plan, {
        root,
        output,
        model: 'openai/example',
        thinking: 'high',
        dryRun: false,
        concurrency: 1,
        execute: (options) =>
          runPi({
            ...options,
            command: process.execPath,
            prefixArgs: [script],
            env: {},
          }),
      });
      assert.equal(result.execution?.callsStarted, 1);
      assert.equal(result.status, REVIEW_VALUES.ERROR);
      assert.equal(
        result.tasks.filter((t) => t.status === REVIEW_VALUES.SKIPPED).length,
        plan.tasks.length - 1,
      );
      await writeArtifacts(result, { output });
      assert.match(
        await readFile(join(output, 'diagnostics.txt'), 'utf8'),
        new RegExp(code),
      );
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY/);
    });
  });
}

void test('a fatal reply closes admission while concurrent Pi calls finish', async () => {
  await fixture(async (root, output) => {
    const plan = buildBaselinePlan([FILE], await repositoryRef(root));
    let notifyStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let calls = 0;
    const result = await runReview(plan, {
      root,
      output,
      model: 'openai/example',
      thinking: 'high',
      dryRun: false,
      concurrency: 2,
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          await started;
          return { ...success(null), failure: REVIEW_FAILURE.KEY };
        }
        notifyStarted();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return success(null);
      },
    });
    assert.equal(calls, 2);
    assert.equal(
      result.tasks.filter((t) => t.status === REVIEW_VALUES.SKIPPED).length,
      plan.tasks.length - 2,
    );
  });
});

void test('quota during first verification prevents the second verifier', async () => {
  await fixture(async (root, output) => {
    const plan = buildBaselinePlan([FILE], await repositoryRef(root));
    let checks = 0;
    const result = await runReview(plan, {
      root,
      output,
      model: 'openai/example',
      thinking: 'high',
      dryRun: false,
      execute: async (options) => {
        if (options.prompt.includes('fresh independent verifier')) {
          checks++;
          return { ...success(null), failure: REVIEW_FAILURE.QUOTA };
        }
        const reviewer = Object.values(REVIEWER_IDS).find((id) =>
          options.prompt.includes('Reviewer: ' + id),
        );
        const bundle = JSON.parse(
          options.prompt.split('Untrusted source bundle (JSON):\n')[1] ?? '',
        );
        return success(hunter(bundle, reviewer, [FINDING]));
      },
    });
    assert.equal(checks, 1);
    assert.equal(result.verifications[0]?.failure, REVIEW_FAILURE.QUOTA);
    assert.equal(
      (await writeArtifacts(result, { output })).status,
      REVIEW_VALUES.ERROR,
    );
  });
});
