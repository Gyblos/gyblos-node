import { setTimeout as delay } from 'node:timers/promises';

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
  candidates(prompt: string, topLogprobs: number): Promise<Candidate[] | null>;
  confirm(): Promise<void>;
}

const unavailable = () =>
  new ModelVerifierError(MODEL_VERIFIER_CODES.REFERENCE_UNAVAILABLE);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};

function catalogModel(modelId: string) {
  const resolved = resolveModel(modelId);
  if (
    resolved.kind !== MODEL_CLASSIFICATIONS.CATALOG ||
    !resolved.model.aliases[0] ||
    !usesPinnedTokenizer(modelId)
  )
    throw new ModelVerifierError(MODEL_VERIFIER_CODES.UNSUPPORTED_MODEL);
  return { id: resolved.model.id, tag: resolved.model.aliases[0] };
}

export function catalogModelId(modelId: string): string {
  return catalogModel(modelId).id;
}

export function referenceTag(modelId: string): string {
  return catalogModel(modelId).tag;
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
    if (!response.body) throw unavailable();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MODEL_VERIFIER.referenceMaxResponseBytes) {
          await reader.cancel();
          throw unavailable();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const parsed: unknown = JSON.parse(
      Buffer.concat(chunks, size).toString('utf8'),
    );
    return record(parsed);
  } catch {
    throw unavailable();
  }
}

function validBytes(value: unknown) {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255))
  );
}

function validOptionalTokenLogprob(entry: Record<string, unknown>) {
  if ('token' in entry && typeof entry.token !== 'string') return false;
  if (
    'logprob' in entry &&
    (typeof entry.logprob !== 'number' ||
      !Number.isFinite(entry.logprob) ||
      entry.logprob > 0)
  )
    return false;
  return validBytes(entry.bytes);
}

function parseCandidates(
  body: Record<string, unknown>,
  topLogprobs: number,
): Candidate[] | null {
  if (
    body.done !== true ||
    typeof body.response !== 'string' ||
    ('done_reason' in body && typeof body.done_reason !== 'string')
  )
    throw unavailable();
  const logprobs = body.logprobs;
  if (logprobs === undefined && body.response === '') return null;
  if (!Array.isArray(logprobs) || logprobs.length !== 1) throw unavailable();
  const first = record(logprobs[0]);
  if (!validOptionalTokenLogprob(first)) throw unavailable();
  const top = first.top_logprobs;
  if (!Array.isArray(top) || top.length !== topLogprobs) throw unavailable();
  const candidates = top.map((item) => {
    const candidate = record(item);
    if (
      typeof candidate.token !== 'string' ||
      typeof candidate.logprob !== 'number' ||
      !Number.isFinite(candidate.logprob) ||
      candidate.logprob > 0 ||
      !validBytes(candidate.bytes)
    )
      throw unavailable();
    return { token: candidate.token, logprob: candidate.logprob };
  });
  if (!candidates.some(({ token }) => token.length > 0)) throw unavailable();
  return candidates;
}

export async function openReference(
  base: string,
  modelId: string,
  fetchImpl: typeof fetch = fetch,
  retryMs: number = MODEL_VERIFIER.referenceRetryMs,
): Promise<ReferenceModel> {
  const tag = referenceTag(modelId);
  const tagsUrl = new URL(ROUTES.ollamaTags, base);
  const digestOf = async () => {
    const tags = await call(fetchImpl, tagsUrl);
    const listed = Array.isArray(tags.models)
      ? tags.models.map(record).find((model) => model.name === tag)
      : undefined;
    if (
      !listed ||
      typeof listed.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(listed.digest)
    )
      throw unavailable();
    return listed.digest;
  };
  const digest = await digestOf();
  const generate = new URL(ROUTES.ollamaGenerate, base);
  return {
    tag,
    digest,
    async confirm() {
      if ((await digestOf()) !== digest)
        throw new ModelVerifierError(MODEL_VERIFIER_CODES.REFERENCE_CHANGED);
    },
    async candidates(prompt, topLogprobs) {
      const body = {
        model: tag,
        prompt,
        raw: true,
        stream: false,
        logprobs: true,
        top_logprobs: topLogprobs,
        options: { temperature: 0, num_predict: 1 },
      };
      for (let attempt = 1; ; attempt++) {
        try {
          return parseCandidates(
            await call(fetchImpl, generate, body),
            topLogprobs,
          );
        } catch (error) {
          if (attempt >= MODEL_VERIFIER.referenceAttempts) throw error;
          await delay(retryMs * attempt);
        }
      }
    },
  };
}
