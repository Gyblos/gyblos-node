import { performance } from 'node:perf_hooks';

import { FREE_BUYER } from '@gyblos/buyer/constants';
import { MODEL_IDS, type FreeChatRole } from '@gyblos/protocol/constants';

import { AGENT_REPLAY, type ReplayRole } from './constants';

export interface ReplayMessage {
  role: FreeChatRole;
  content: string;
}

export interface ReplayTiming {
  tag: string;
  role: ReplayRole;
  turn: number;
  startMs: number;
  headersMs: number | null;
  firstTokenMs: number | null;
  totalMs: number;
  status: number;
  code: string | null;
  text: string;
}

const DATA = 'data: ';

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};

export function frameOf(line: string): { text?: string; error?: string } {
  if (!line.startsWith(DATA) || line === `${DATA}${FREE_BUYER.streamDone}`)
    return {};
  const chunk = record(JSON.parse(line.slice(DATA.length)));
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const content = record(record(choices[0]).delta).content;
  const error = chunk.error === undefined ? undefined : record(chunk.error);
  return {
    text: typeof content === 'string' ? content : '',
    error: error
      ? typeof error.code === 'string'
        ? error.code
        : FREE_BUYER.errorType
      : undefined,
  };
}

export async function readStream(
  body: ReadableStream<Uint8Array>,
  began: number,
  timing: ReplayTiming,
) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const { text, error } = frameOf(line.trim());
      if (error) timing.code = error;
      if (text && timing.firstTokenMs === null)
        timing.firstTokenMs = performance.now() - began;
      timing.text += text ?? '';
    }
  }
}

async function errorCode(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; type?: string };
    };
    return body.error?.code ?? body.error?.type ?? null;
  } catch {
    return null;
  }
}

export async function replayRequest(
  url: string,
  request: {
    tag: string;
    role: ReplayRole;
    turn: number;
    messages: ReplayMessage[];
  },
  origin: number,
  signal: AbortSignal,
): Promise<ReplayTiming> {
  const began = performance.now();
  const timing: ReplayTiming = {
    tag: request.tag,
    role: request.role,
    turn: request.turn,
    startMs: began - origin,
    headersMs: null,
    firstTokenMs: null,
    totalMs: 0,
    status: 0,
    code: null,
    text: '',
  };
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_IDS.QWEN3_0_6B,
        messages: request.messages,
        max_tokens: AGENT_REPLAY.maxTokens,
        stream: true,
      }),
    });
    timing.headersMs = performance.now() - began;
    timing.status = response.status;
    if (response.ok && response.body)
      await readStream(response.body, began, timing);
    else timing.code = await errorCode(response);
  } catch (error) {
    timing.code = error instanceof Error ? error.name : 'unknown';
  }
  timing.totalMs = performance.now() - began;
  return timing;
}
