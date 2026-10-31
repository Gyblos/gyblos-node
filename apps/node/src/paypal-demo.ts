// Serves the local sandbox checkout demo; the injected node service owns payment state and inference.
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import {
  createPaypalSession,
  type PaypalSessionDependencies,
} from '@gyblos/node/paypal-session';
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
<body><main><h1>Gyblos inference · PayPal Sandbox</h1>
<p>Approve a hold of up to USD ${PAYPAL_SANDBOX.price}. Each completed response costs USD ${PAYPAL_SANDBOX.messagePrice} in sandbox funds. Close the session to capture only the acknowledged responses, up to ten.</p>
<p>Each message is independent; previous messages are not sent as context. A session accepts messages for 30 minutes after authorization. Close it explicitly to settle or release the hold.</p>
<button id="create">Create sandbox session</button><p><a id="approve" target="_blank" rel="noopener noreferrer" hidden>Approve in PayPal Sandbox</a></p>
<button id="authorize" disabled>I approved · start session</button><button id="cancel" disabled>Abandon unapproved order</button>
<p id="balance"></p><label for="prompt">Your prompt</label><br><textarea id="prompt" rows="6" cols="60" maxlength="4096"></textarea><br>
<button id="send" disabled>Send message</button><button id="finish" disabled>Close session and settle</button><p id="status" role="status"></p><pre id="answer"></pre></main>
<script>
let orderId; let pendingId; const maxTokens = 64; const sessionToken = location.hash.slice(1);
const status = document.getElementById('status'); const balance = document.getElementById('balance');
const el = (id) => document.getElementById(id);
async function post(path, body) { const result = await fetch(path, { method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + sessionToken}, body: JSON.stringify(body) }); const data = await result.json(); if (!result.ok) { const error = new Error(data.error); error.retryable = data.retryable; throw error; } return data; }
function show(state) { balance.textContent = 'Recorded usage: USD ' + (state.spentCents / 100).toFixed(2) + ' of USD ' + (state.limitCents / 100).toFixed(2); el('create').disabled = !['ready','completed','voided','cancelled'].includes(state.phase); el('send').disabled = state.phase !== 'active' || state.spentCents + state.messageCents > state.limitCents; el('finish').disabled = state.phase !== 'active'; el('cancel').disabled = state.phase !== 'created'; if (state.phase === 'message_pending') status.textContent = 'A response has not been acknowledged. Reconcile this session before continuing.'; if (['executing','capturing','voiding','authorizing','creating','blocked'].includes(state.phase)) status.textContent = 'The session has an uncertain operation. Check its status before continuing.'; }
el('create').onclick = async () => { el('create').disabled = true; try { const data = await post('/api/order', {}); orderId = data.orderId; const link = el('approve'); link.href = data.approvalUrl; link.hidden = false; el('authorize').disabled = false; el('cancel').disabled = false; status.textContent = 'Approve the USD ${PAYPAL_SANDBOX.price} hold, then return here.'; } catch (error) { status.textContent = error.message; } };
el('authorize').onclick = async () => { el('authorize').disabled = true; try { const state = await post('/api/approve', {orderId}); el('approve').hidden = true; show(state); status.textContent = 'Session authorized. Send independent messages, then close the session.'; } catch (error) { if (error.retryable) el('authorize').disabled = false; status.textContent = error.message; } };
el('send').onclick = async () => { el('send').disabled = true; el('finish').disabled = true; status.textContent = 'Generating…'; try { const data = await post('/api/message', {prompt: el('prompt').value, maxTokens}); pendingId = data.messageId; el('answer').textContent = data.text; const state = await post('/api/acknowledge', {messageId: pendingId}); pendingId = undefined; show(state); status.textContent = 'Response acknowledged.'; } catch (error) { status.textContent = error.message; if (!pendingId) { try { show(await post('/api/status', {})); } catch {} } } };
el('finish').onclick = async () => { el('send').disabled = true; el('finish').disabled = true; try { const state = await post('/api/finish', {}); show(state); status.textContent = state.spentCents ? 'Sandbox payment captured for acknowledged responses.' : 'Unused authorization voided.'; } catch (error) { status.textContent = error.message; } };
el('cancel').onclick = async () => { try { await post('/api/cancel', {}); location.reload(); } catch (error) { status.textContent = error.message; } };
post('/api/status', {}).then(show).catch((error) => { status.textContent = error.message; });
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
  service: Awaited<ReturnType<typeof createPaypalSession>>,
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
      if (request.url === '/api/status')
        return json(response, HTTP.ok, service.status());
      if (request.url === '/api/order')
        return json(response, HTTP.ok, await service.create());
      if (request.url === '/api/cancel') {
        await service.cancel();
        return json(response, HTTP.ok, { cancelled: true });
      }
      if (request.url === '/api/approve' && typeof input.orderId === 'string')
        return json(response, HTTP.ok, await service.approve(input.orderId));
      if (
        request.url === '/api/acknowledge' &&
        typeof input.messageId === 'string'
      )
        return json(
          response,
          HTTP.ok,
          await service.acknowledge(input.messageId),
        );
      if (request.url === '/api/finish')
        return json(response, HTTP.ok, await service.finish());
      if (
        request.url === '/api/message' &&
        typeof input.prompt === 'string' &&
        typeof input.maxTokens === 'number'
      ) {
        const controller = new AbortController();
        response.once('close', () => {
          if (!response.writableEnded) controller.abort();
        });
        return json(
          response,
          HTTP.ok,
          await service.message(
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
  options: PaypalSessionDependencies & { port: number },
) {
  const service = await createPaypalSession(options);
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
