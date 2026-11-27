import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { DIAGNOSTIC_LEVELS } from '@gyblos/runtime/constants';
import {
  createDiagnostics,
  diagnosticCause,
  type DiagnosticSink,
} from '@gyblos/runtime/diagnostics';

import { OPENCODE_PROXY_DIAGNOSTICS } from './paid-acceptance-constants';

export const interruptedFragment = 'a'.repeat(64) + ' ';
export async function interruptedGeneration(
  onText: ((text: string) => Promise<void>) | undefined,
  signal: AbortSignal,
): Promise<never> {
  signal.throwIfAborted();
  await onText?.(interruptedFragment);
  signal.throwIfAborted();
  return new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    }),
  );
}
type Phases = typeof OPENCODE_PROXY_DIAGNOSTICS.phases;
export type ProxyStage = Phases[keyof Phases];
export function interruptionProxy(options: {
  upstream(init: RequestInit): Promise<Response>;
  headers(response: Response): Promise<void>;
  cut(seen: string): Promise<boolean>;
  disconnected?(): void;
  diagnostics?: DiagnosticSink;
  failure(stage: ProxyStage): void;
}) {
  const { phases, codes } = OPENCODE_PROXY_DIAGNOSTICS;
  const diagnostics = createDiagnostics({
    ...OPENCODE_PROXY_DIAGNOSTICS,
    phases: Object.values(phases),
    codes: Object.values(codes),
    sink: options.diagnostics,
    level: DIAGNOSTIC_LEVELS.DEBUG,
  });
  return createServer(async (req, res) => {
    const observation = diagnostics.start();
    const signal = new AbortController();
    res.on('close', () => signal.abort());
    let stage: ProxyStage = phases.INPUT;
    let plannedCut = false;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.url, '/v1/chat/completions');
      stage = phases.UPSTREAM;
      const response = await options.upstream({
        method: 'POST',
        headers: {
          authorization: req.headers.authorization ?? '',
          'content-type': 'application/json',
        },
        body: Buffer.concat(chunks),
        signal: signal.signal,
      });
      await options.headers(response);
      res.writeHead(
        response.status,
        Object.fromEntries(
          [...response.headers].filter(
            ([name]) =>
              ![
                'connection',
                'keep-alive',
                'transfer-encoding',
                'content-length',
                'content-encoding',
              ].includes(name),
          ),
        ),
      );
      stage = phases.STREAM;
      assert.ok(response.body);
      let seen = '';
      for await (const bytes of response.body) {
        res.write(bytes);
        seen += Buffer.from(bytes).toString();
        if (await options.cut(seen)) {
          plannedCut = true;
          res.destroy();
          signal.abort();
          options.disconnected?.();
          return;
        }
      }
      res.end();
    } catch (error) {
      if (!plannedCut) {
        observation.report({
          phase: stage,
          code: codes.FAILED,
          cause: diagnosticCause(error),
        });
        options.failure(stage);
      }
      res.destroy();
    }
  });
}
