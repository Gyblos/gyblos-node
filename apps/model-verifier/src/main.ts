import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { modelVerifierLayout } from '@gyblos/config/model-verifier-home';
import {
  verifyModelVerification,
  type SignedModelVerification,
} from '@gyblos/protocol/model-verification';
import { isMain } from '@gyblos/runtime';
import { withDiagnosticCleanup } from '@gyblos/runtime/diagnostic-cleanup';
import { createDiagnostics } from '@gyblos/runtime/diagnostics';

import { CHALLENGE_SET, challengeSetDigest } from './challenge-set';
import {
  MODEL_VERIFIER,
  MODEL_VERIFIER_CODES,
  MODEL_VERIFIER_COMMANDS,
  MODEL_VERIFIER_OUTPUT_DIAGNOSTICS,
  ModelVerifierError,
  SECRET_BYTES,
  type ModelVerifierCode,
} from './constants';
import { loadVerifierKey } from './key';
import { catalogModelId, openReference } from './reference';
import { runVerification, type VerificationOutput } from './verify';

const OPTIONS = {
  seller: { type: 'string' },
  model: { type: 'string' },
  ollama: { type: 'string' },
  out: { type: 'string' },
} as const;

const usage = () => new ModelVerifierError(MODEL_VERIFIER_CODES.USAGE);

async function readJson(path: string, code: ModelVerifierCode) {
  try {
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text) > MODEL_VERIFIER.maxSellerFileBytes)
      throw new ModelVerifierError(code);
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new ModelVerifierError(code);
  }
}

function summary(signed: SignedModelVerification) {
  const { result } = signed;
  return {
    ok: true,
    verdict: result.verdict,
    verifier: result.verifier,
    nodeId: result.seller.nodeId,
    model: result.selection.modelId,
    challengeSet: `${result.challengeSet.id}@${result.challengeSet.version}`,
    checks: result.evidence.checks,
    deviations: result.evidence.deviations,
    deviantAnswers: result.evidence.deviantAnswers,
    failAt: result.evidence.failAt,
  };
}

async function publishOutput(
  out: string,
  { signed, answers, unscored }: VerificationOutput,
) {
  const parentPath = dirname(out);
  await mkdir(parentPath, {
    recursive: true,
    mode: MODEL_VERIFIER.directoryMode,
  });
  const parent = await realpath(parentPath);
  const destination = join(parent, basename(out));
  const staging = await mkdtemp(join(parent, MODEL_VERIFIER.stagingPrefix));
  const diagnostics = createDiagnostics({
    ...MODEL_VERIFIER_OUTPUT_DIAGNOSTICS,
    phases: Object.values(MODEL_VERIFIER_OUTPUT_DIAGNOSTICS.phases),
    codes: [MODEL_VERIFIER_CODES.OUTPUT_CLEANUP_FAILED],
    sink: (record) => console.error(JSON.stringify(record)),
  }).start();
  let published = false;
  await withDiagnosticCleanup(
    async () => {
      const options = { flag: 'wx', mode: MODEL_VERIFIER.privateFileMode };
      await writeFile(
        join(staging, MODEL_VERIFIER.resultFile),
        `${JSON.stringify(signed, null, 2)}\n`,
        options,
      );
      await writeFile(
        join(staging, MODEL_VERIFIER.evidenceFile),
        `${JSON.stringify({ challengeSet: CHALLENGE_SET, answers, unscored }, null, 2)}\n`,
        options,
      );
      const exists = await lstat(destination).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return false;
        },
      );
      if (exists)
        throw new ModelVerifierError(MODEL_VERIFIER_CODES.OUTPUT_EXISTS);
      await rename(staging, destination);
      published = true;
    },
    async () => {
      if (!published) await rm(staging, { recursive: true, force: true });
    },
    () =>
      diagnostics.report({
        phase: MODEL_VERIFIER_OUTPUT_DIAGNOSTICS.phases.cleanup,
        code: MODEL_VERIFIER_CODES.OUTPUT_CLEANUP_FAILED,
      }),
  );
}

async function verify(values: Record<string, string | undefined>) {
  if (!values.seller || !values.model) throw usage();
  const { openSeller, parseSellerTarget } = await import('./seller');
  const { bindEndpoint } = await import('@gyblos/transport-iroh/endpoint');
  const modelId = catalogModelId(values.model);
  const target = parseSellerTarget(
    await readJson(values.seller, MODEL_VERIFIER_CODES.INVALID_SELLER),
  );
  const paths = modelVerifierLayout(process.env);
  const key = await loadVerifierKey(paths.key, true);
  const reference = await openReference(
    values.ollama ?? MODEL_VERIFIER.defaultOllamaUrl,
    values.model,
  );
  const endpoint = await bindEndpoint([...randomBytes(SECRET_BYTES)], {
    http: false,
  });
  try {
    const seller = await openSeller(endpoint, target, modelId);
    try {
      const outcome = await runVerification({
        target,
        seller,
        reference,
        set: CHALLENGE_SET,
        key,
        now: Date.now,
        onAnswer: (index, failure) =>
          console.error(
            JSON.stringify({
              challenge: index + 1,
              answered: failure === undefined,
              ...(failure ? { code: failure } : {}),
            }),
          ),
      });
      const out =
        values.out ??
        join(
          paths.results,
          `${outcome.signed.result.issuedAt}-${target.nodeId}`,
        );
      await publishOutput(out, outcome);
      return { ...summary(outcome.signed), out };
    } finally {
      await seller.close();
    }
  } finally {
    await endpoint.close();
  }
}

function publishedRule({ result }: SignedModelVerification) {
  const { rule, prompts } = CHALLENGE_SET;
  const { challengeSet, evidence } = result;
  return (
    challengeSet.id === CHALLENGE_SET.id &&
    challengeSet.version === CHALLENGE_SET.version &&
    challengeSet.digest === challengeSetDigest(CHALLENGE_SET) &&
    evidence.prompts === prompts.length &&
    evidence.minimumChecks === rule.minimumChecks &&
    evidence.honestRatePpm === rule.honestRatePpm &&
    evidence.falsePositivePpm === rule.falsePositivePpm
  );
}

async function check(path: string | undefined) {
  if (!path) throw usage();
  let signed: SignedModelVerification;
  try {
    signed = await verifyModelVerification(
      await readJson(path, MODEL_VERIFIER_CODES.INVALID_RESULT),
    );
  } catch {
    throw new ModelVerifierError(MODEL_VERIFIER_CODES.INVALID_RESULT);
  }
  if (!publishedRule(signed))
    throw new ModelVerifierError(MODEL_VERIFIER_CODES.INVALID_RESULT);
  return summary(signed);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const [command, file] = positionals;
    let output: object;
    if (command === MODEL_VERIFIER_COMMANDS.VERIFY)
      output = await verify(values);
    else if (command === MODEL_VERIFIER_COMMANDS.CHECK)
      output = await check(file);
    else if (command === MODEL_VERIFIER_COMMANDS.ADDRESS) {
      const key = await loadVerifierKey(
        modelVerifierLayout(process.env).key,
        true,
      );
      output = { ok: true, verifier: key.address };
    } else throw usage();
    console.log(JSON.stringify(output));
    return 0;
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code:
          error instanceof ModelVerifierError
            ? error.code
            : MODEL_VERIFIER_CODES.INTERNAL,
      }),
    );
    return 1;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
