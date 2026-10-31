// Serves the local sandbox checkout demo; the injected node service owns payment state and inference.
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import {
  createPaypalInference,
  type PaypalInferenceDependencies,
} from '@gyblos/node/paypal-inference';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

const HTTP = {
  ok: 200,
  badRequest: 400,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
} as const;
const BODY_BYTES = 16384;
const SESSION_BYTES = 32;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gyblos PayPal Sandbox</title></head>
<body><main><h1>Gyblos inference · PayPal Sandbox</h1><p>One bounded inference: ${PAYPAL_SANDBOX.currency} ${PAYPAL_SANDBOX.price} in sandbox funds. A seller receives the payment after generation.</p>
<label for="prompt">Your prompt</label><br><textarea id="prompt" rows="6" cols="60" maxlength="4096"></textarea><br>
<button id="create">Create sandbox order</button><p><a id="approve" target="_blank" rel="noopener noreferrer" hidden>Approve in PayPal Sandbox</a></p>
<button id="execute" disabled>I approved the payment · run inference</button><p id="status" role="status"></p><pre id="answer"></pre></main>
<button id="cancel">Abandon an order that has not been authorized</button>
<script>
let orderId; let requestPrompt; const maxTokens = 64; const sessionToken = location.hash.slice(1);
const status = document.getElementById('status');
async function post(path, body) { const result = await fetch(path, { method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + sessionToken}, body: JSON.stringify(body) }); const data = await result.json(); if (!result.ok) { const error = new Error(data.error); error.retryable = data.retryable; throw error; } return data; }
document.getElementById('create').onclick = async () => { try { requestPrompt = document.getElementById('prompt').value; const data = await post('/api/order', {prompt: requestPrompt, maxTokens}); orderId = data.orderId; const link = document.getElementById('approve'); link.href = data.approvalUrl; link.hidden = false; document.getElementById('execute').disabled = false; document.getElementById('create').disabled = true; status.textContent = 'Approve the order, then return here.'; } catch (error) { status.textContent = error.message; } };
document.getElementById('execute').onclick = async () => { document.getElementById('execute').disabled = true; status.textContent = 'Authorizing, generating, and capturing…'; try { const data = await post('/api/execute', {orderId, prompt: requestPrompt, maxTokens}); document.getElementById('answer').textContent = data.text; status.textContent = 'Sandbox payment captured.'; } catch (error) { if (error.retryable) document.getElementById('execute').disabled = false; status.textContent = error.message; } };
document.getElementById('cancel').onclick = async () => { try { await post('/api/cancel', {}); location.reload(); } catch (error) { status.textContent = error.message; } };
</script></body></html>`;

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let data = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    data += String(chunk);
    if (Buffer.byteLength(data) > BODY_BYTES)
      throw new Error('Request too large');
  }
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid request');
  return Object.fromEntries(Object.entries(value));
}

function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

function servePage(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
): boolean {
  const path = new URL(request.url ?? '/', origin).pathname;
  if (request.method !== 'GET') return false;
  if (path === '/paypal/approved' || path === '/paypal/cancelled') {
    response.writeHead(HTTP.ok, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end('Return to the Gyblos tab to continue.');
    return true;
  }
  if (request.url !== '/') return false;
  response.writeHead(HTTP.ok, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  response.end(PAGE);
  return true;
}

function demoHandler(
  service: Awaited<ReturnType<typeof createPaypalInference>>,
  getOrigin: () => string,
  sessionToken: string,
) {
  return (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const origin = getOrigin();
      if (request.headers.host !== new URL(origin).host)
        return json(response, HTTP.forbidden, { error: 'Forbidden' });
      if (servePage(request, response, origin)) return;
      if (
        request.method !== 'POST' ||
        request.headers.origin !== origin ||
        request.headers['content-type'] !== 'application/json' ||
        request.headers.authorization !== `Bearer ${sessionToken}`
      )
        return json(response, HTTP.forbidden, { error: 'Forbidden' });
      const input = await body(request);
      if (request.url === '/api/cancel') {
        await service.cancel();
        return json(response, HTTP.ok, { cancelled: true });
      }
      if (
        typeof input.prompt !== 'string' ||
        typeof input.maxTokens !== 'number'
      )
        return json(response, HTTP.badRequest, { error: 'Invalid request' });
      if (request.url === '/api/order')
        return json(
          response,
          HTTP.ok,
          await service.create(input.prompt, input.maxTokens),
        );
      if (request.url === '/api/execute' && typeof input.orderId === 'string') {
        const controller = new AbortController();
        response.once('close', () => {
          if (!response.writableEnded) controller.abort();
        });
        return json(
          response,
          HTTP.ok,
          await service.execute(
            input.orderId,
            input.prompt,
            input.maxTokens,
            controller.signal,
          ),
        );
      }
      return json(response, HTTP.notFound, { error: 'Not found' });
    })().catch((error: unknown) => {
      if (
        error instanceof PaypalError &&
        error.code === PAYPAL_ERROR_CODES.NOT_APPROVED
      )
        return json(response, HTTP.conflict, {
          error: 'Approve in PayPal before continuing.',
          retryable: true,
        });
      return json(response, HTTP.conflict, {
        error:
          'The request could not be completed. Check payment status before trying again.',
      });
    });
  };
}

export async function startPaypalDemo(
  options: PaypalInferenceDependencies & { port: number },
) {
  const service = await createPaypalInference(options);
  const sessionToken = randomBytes(SESSION_BYTES).toString('base64url');
  let origin = '';
  const server = createServer(demoHandler(service, () => origin, sessionToken));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Invalid listener');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    accessUrl: `${origin}/#${sessionToken}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
