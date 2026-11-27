import assert from 'node:assert/strict';
import { createServer } from 'node:http';

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
export type ProxyStage = 'input' | 'upstream' | 'stream';
export function interruptionProxy(options: {
  upstream(init: RequestInit): Promise<Response>;
  headers(response: Response): Promise<void>;
  cut(seen: string): Promise<boolean>;
  disconnected(): void;
  failure(stage: ProxyStage): void;
}) {
  return createServer(async (req, res) => {
    const signal = new AbortController();
    res.on('close', () => signal.abort());
    let stage: ProxyStage = 'input';
    let plannedCut = false;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.url, '/v1/chat/completions');
      stage = 'upstream';
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
      stage = 'stream';
      assert.ok(response.body);
      let seen = '';
      for await (const bytes of response.body) {
        res.write(bytes);
        seen += Buffer.from(bytes).toString();
        if (await options.cut(seen)) {
          plannedCut = true;
          res.destroy();
          signal.abort();
          options.disconnected();
          return;
        }
      }
      res.end();
    } catch {
      if (!plannedCut) options.failure(stage);
      res.destroy();
    }
  });
}
