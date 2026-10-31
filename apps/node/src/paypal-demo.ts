// Serves the local sandbox checkout demo; the injected node service owns payment state and inference.
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import {
  createPaypalInference,
  type PaypalInferenceDependencies,
} from '@gyblos/node/paypal-inference';
import { PAYPAL_SANDBOX } from '@gyblos/payments-paypal';

const HTTP = {
  ok: 200,
  badRequest: 400,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
} as const;
const BODY_BYTES = 16384;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Gyblos PayPal Sandbox</title></head>
<body><main><h1>Gyblos inference · PayPal Sandbox</h1><p>One bounded inference: ${PAYPAL_SANDBOX.currency} ${PAYPAL_SANDBOX.price} in sandbox funds. A seller receives the payment after generation.</p>
<label for="prompt">Your prompt</label><br><textarea id="prompt" rows="6" cols="60" maxlength="4096"></textarea><br>
<button id="create">Create sandbox order</button><p><a id="approve" target="_blank" rel="noopener noreferrer" hidden>Approve in PayPal Sandbox</a></p>
<button id="execute" disabled>I approved the payment · run inference</button><p id="status" role="status"></p><pre id="answer"></pre></main>
<script>
let orderId; let requestPrompt; const maxTokens = 64;
const status = document.getElementById('status');
async function post(path, body) { const result = await fetch(path, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) }); const data = await result.json(); if (!result.ok) throw new Error(data.error); return data; }
document.getElementById('create').onclick = async () => { try { requestPrompt = document.getElementById('prompt').value; const data = await post('/api/order', {prompt: requestPrompt, maxTokens}); orderId = data.orderId; const link = document.getElementById('approve'); link.href = data.approvalUrl; link.hidden = false; document.getElementById('execute').disabled = false; document.getElementById('create').disabled = true; status.textContent = 'Approve the order, then return here.'; } catch (error) { status.textContent = error.message; } };
document.getElementById('execute').onclick = async () => { document.getElementById('execute').disabled = true; status.textContent = 'Authorizing, generating, and capturing…'; try { const data = await post('/api/execute', {orderId, prompt: requestPrompt, maxTokens}); document.getElementById('answer').textContent = data.text; status.textContent = 'Sandbox payment captured.'; } catch (error) { status.textContent = error.message + ' Do not retry until the payment is reconciled.'; } };
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

export async function startPaypalDemo(
  options: PaypalInferenceDependencies & { port: number },
) {
  const service = await createPaypalInference(options);
  let origin = '';
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.host !== new URL(origin).host)
        return json(response, HTTP.forbidden, { error: 'Forbidden' });
      if (request.method === 'GET' && request.url === '/') {
        response.writeHead(HTTP.ok, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
        });
        return response.end(PAGE);
      }
      if (
        request.method !== 'POST' ||
        request.headers.origin !== origin ||
        request.headers['content-type'] !== 'application/json'
      )
        return json(response, HTTP.forbidden, { error: 'Forbidden' });
      const input = await body(request);
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
      if (request.url === '/api/execute' && typeof input.orderId === 'string')
        return json(
          response,
          HTTP.ok,
          await service.execute(input.orderId, input.prompt, input.maxTokens),
        );
      return json(response, HTTP.notFound, { error: 'Not found' });
    })().catch(() =>
      json(response, HTTP.conflict, {
        error: 'The request could not be completed. Check payment status.',
      }),
    );
  });
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
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
