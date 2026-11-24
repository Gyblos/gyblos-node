import { ROUTES } from '@gyblos/config';
import { MODEL_CLASSIFICATIONS } from '@gyblos/protocol/constants';
import { resolveModel, usesPinnedTokenizer } from '@gyblos/protocol/models';

import {
  MODEL_VERIFIER,
  MODEL_VERIFIER_CODES,
  ModelVerifierError,
} from './constants';
import type { Candidate } from './scoring';

export interface ReferenceModel {
  tag: string;
  digest: string;
  candidates(prompt: string, topLogprobs: number): Promise<Candidate[]>;
}

const unavailable = () =>
  new ModelVerifierError(MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

export function referenceTag(modelId: string): string {
  const resolved = resolveModel(modelId);
  const tag =
    resolved.kind === MODEL_CLASSIFICATIONS.CATALOG
      ? resolved.model.aliases[0]
      : undefined;
  if (!tag || !usesPinnedTokenizer(modelId))
    throw new ModelVerifierError(MODEL_VERIFIER_CODES.UNSUPPORTED_MODEL);
  return tag;
}

async function call(
  fetchImpl: typeof fetch,
  url: URL,
  body?: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(MODEL_VERIFIER.referenceTimeoutMs),
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
  } catch {
    throw unavailable();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  try {
    return record(await response.json());
  } catch {
    throw unavailable();
  }
}

function parseCandidates(body: Record<string, unknown>): Candidate[] {
  const logprobs = body.logprobs;
  const first = Array.isArray(logprobs) ? record(logprobs[0]) : {};
  const top = first.top_logprobs;
  if (!Array.isArray(top)) throw unavailable();
  return top.map((item) => {
    const candidate = record(item);
    if (
      typeof candidate.token !== 'string' ||
      typeof candidate.logprob !== 'number' ||
      !Number.isFinite(candidate.logprob)
    )
      throw unavailable();
    return { token: candidate.token, logprob: candidate.logprob };
  });
}

export async function openReference(
  base: string,
  modelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReferenceModel> {
  const tag = referenceTag(modelId);
  const tags = await call(fetchImpl, new URL(ROUTES.ollamaTags, base));
  const listed = Array.isArray(tags.models)
    ? tags.models.map(record).find((model) => model.name === tag)
    : undefined;
  if (!listed || typeof listed.digest !== 'string') throw unavailable();
  const generate = new URL(ROUTES.ollamaGenerate, base);
  return {
    tag,
    digest: listed.digest,
    async candidates(prompt, topLogprobs) {
      return parseCandidates(
        await call(fetchImpl, generate, {
          model: tag,
          prompt,
          raw: true,
          stream: false,
          logprobs: true,
          top_logprobs: topLogprobs,
          options: { temperature: 0, num_predict: 1 },
        }),
      );
    },
  };
}
