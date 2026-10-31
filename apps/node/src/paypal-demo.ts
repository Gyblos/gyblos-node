// Serves the local sandbox checkout demo; the injected node service owns payment state and inference.
import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { PAYPAL_SANDBOX } from '@gyblos/config/constants';
import {
  PAYPAL_SESSION_PHASE,
  PAYPAL_SESSION_STATUS,
} from '@gyblos/node/constants';
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
<p>Approve a hold of up to USD ${PAYPAL_SANDBOX.price}. Each completed response costs USD ${PAYPAL_SANDBOX.messagePrice} in sandbox funds. Close the session to capture only the acknowledged responses, up to ${PAYPAL_SANDBOX.limitCents / PAYPAL_SANDBOX.messageCents}.</p>
<p>Each message is independent; previous messages are not sent as context. A session accepts up to ${PAYPAL_SANDBOX.maxMessageAttempts} attempts, including failures, for ${PAYPAL_SANDBOX.sessionMinutes} minutes after authorization. Close it explicitly to settle or release the hold.</p>
<button id="create">Create sandbox session</button><p><a id="approve" target="_blank" rel="noopener noreferrer" hidden>Approve in PayPal Sandbox</a></p>
<button id="authorize" disabled>I approved · start session</button><button id="cancel" disabled>Abandon unapproved order</button>
<p id="balance"></p><label for="prompt">Your prompt</label><br><textarea id="prompt" rows="6" cols="60" maxlength="4096"></textarea><br>
<button id="send" disabled>Send message</button><button id="retryAck" hidden>Retry response acknowledgment</button><button id="finish" disabled>Close session and settle</button><p id="status" role="status"></p><pre id="answer"></pre></main>
<script>
const PHASE = ${JSON.stringify(PAYPAL_SESSION_PHASE)}; const STATUS = ${JSON.stringify(PAYPAL_SESSION_STATUS)};
const centsPerDollar = ${PAYPAL_SANDBOX.centsPerDollar}; const pendingKey = 'gyblosPaypalPendingMessage'; const orderKey = 'gyblosPaypalOrder';
let orderId = sessionStorage.getItem(orderKey); let pending = JSON.parse(sessionStorage.getItem(pendingKey) || 'null'); const maxTokens = 64; const sessionToken = location.hash.slice(1);
const status = document.getElementById('status'); const balance = document.getElementById('balance');
const el = (id) => document.getElementById(id);
function savePending(value) { pending = value; if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value)); else sessionStorage.removeItem(pendingKey); }
async function post(path, body) { const result = await fetch(path, { method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + sessionToken}, body: JSON.stringify(body) }); const data = await result.json(); if (!result.ok) { const error = new Error(data.error); error.retryable = data.retryable; throw error; } return data; }
function show(state) {
  if (!orderId && state.orderId) { orderId = state.orderId; sessionStorage.setItem(orderKey, orderId); }
  const stale = !!orderId && !!state.orderId && orderId !== state.orderId;
  if (pending && !pending.received && state.phase === PHASE.ACTIVE) savePending(null);
  balance.textContent = 'Recorded usage: USD ' + (state.spentCents / centsPerDollar).toFixed(2) + ' of USD ' + (state.limitCents / centsPerDollar).toFixed(2);
  el('create').disabled = stale || ![STATUS.READY, PHASE.COMPLETED, PHASE.VOIDED, PHASE.CANCELLED].includes(state.phase);
  el('send').disabled = stale || !!pending || state.phase !== PHASE.ACTIVE || state.expired || state.remainingAttempts === 0 || state.spentCents + state.messageCents > state.limitCents;
  el('finish').disabled = stale || !!pending || state.phase !== PHASE.ACTIVE; el('cancel').disabled = stale || state.phase !== PHASE.CREATED;
  el('retryAck').hidden = stale || !(pending && pending.received);
  if (stale) status.textContent = 'This tab belongs to another session. Reopen the current session link.';
  if (state.expired && state.phase === PHASE.ACTIVE) status.textContent = 'Session expired for new messages. Close it to settle.';
  if (state.remainingAttempts === 0 && state.phase === PHASE.ACTIVE) status.textContent = 'Attempt limit reached. Close the session to settle.';
  if (state.phase === PHASE.MESSAGE_PENDING && !(pending && pending.received)) status.textContent = 'A response was not acknowledged. Reconcile this session before continuing.';
  if ([PHASE.EXECUTING, PHASE.CAPTURING, PHASE.VOIDING, PHASE.AUTHORIZING, PHASE.CREATING, STATUS.BLOCKED].includes(state.phase)) status.textContent = 'The session has an uncertain operation. Check its status before continuing.';
}
async function refresh() { const state = await post('/api/status', {}); show(state); return state; }
async function acknowledge() { const state = await post('/api/acknowledge', {orderId, messageId: pending.id}); savePending(null); show(state); status.textContent = 'Response acknowledged.'; }
el('create').onclick = async () => { el('create').disabled = true; try { const data = await post('/api/order', {}); savePending(null); orderId = data.orderId; sessionStorage.setItem(orderKey, orderId); const link = el('approve'); link.href = data.approvalUrl; link.hidden = false; el('authorize').disabled = false; el('cancel').disabled = false; status.textContent = 'Approve the USD ${PAYPAL_SANDBOX.price} hold, then return here.'; } catch (error) { try { await refresh(); } catch {} status.textContent = error.message; } };
el('authorize').onclick = async () => { el('authorize').disabled = true; try { const state = await post('/api/approve', {orderId}); el('approve').hidden = true; show(state); status.textContent = 'Session authorized. Send independent messages, then close the session.'; } catch (error) { try { const state = await refresh(); if (state.phase === PHASE.CREATED) el('authorize').disabled = false; } catch {} status.textContent = error.message; } };
el('send').onclick = async () => { el('send').disabled = true; el('finish').disabled = true; status.textContent = 'Generating…'; const messageId = crypto.randomUUID(); savePending({id: messageId, received: false}); try { const data = await post('/api/message', {orderId, prompt: el('prompt').value, maxTokens, messageId}); el('answer').textContent = data.text; savePending({id: messageId, received: true}); await acknowledge(); } catch (error) { try { await refresh(); } catch {} status.textContent = error.message; } };
el('retryAck').onclick = async () => { try { await acknowledge(); } catch (error) { status.textContent = error.message; } };
el('finish').onclick = async () => { el('send').disabled = true; el('finish').disabled = true; try { const state = await post('/api/finish', {orderId}); show(state); status.textContent = state.spentCents ? 'Sandbox payment captured for acknowledged responses.' : 'Unused authorization voided.'; } catch (error) { try { await refresh(); } catch {} status.textContent = error.message; } };
el('cancel').onclick = async () => { try { await post('/api/cancel', {orderId}); location.reload(); } catch (error) { status.textContent = error.message; } };
refresh().catch((error) => { status.textContent = error.message; });
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

function demoError(response: ServerResponse, error: unknown) {
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
      const controller = new AbortController();
      response.once('close', () => {
        if (!response.writableEnded) controller.abort();
      });
      const input = await body(request);
      if (request.url === '/api/status')
        return json(response, HTTP.ok, service.status());
      if (request.url === '/api/order')
        return json(response, HTTP.ok, await service.create());
      if (request.url === '/api/cancel' && typeof input.orderId === 'string') {
        await service.cancel(input.orderId);
        return json(response, HTTP.ok, { cancelled: true });
      }
      if (request.url === '/api/approve' && typeof input.orderId === 'string')
        return json(response, HTTP.ok, await service.approve(input.orderId));
      if (
        request.url === '/api/acknowledge' &&
        typeof input.orderId === 'string' &&
        typeof input.messageId === 'string'
      )
        return json(
          response,
          HTTP.ok,
          await service.acknowledge(input.orderId, input.messageId),
        );
      if (request.url === '/api/finish' && typeof input.orderId === 'string')
        return json(response, HTTP.ok, await service.finish(input.orderId));
      if (
        request.url === '/api/message' &&
        typeof input.orderId === 'string' &&
        typeof input.prompt === 'string' &&
        typeof input.maxTokens === 'number' &&
        typeof input.messageId === 'string'
      ) {
        if (response.destroyed || request.aborted) controller.abort();
        return json(
          response,
          HTTP.ok,
          await service.message(
            input.orderId,
            input.prompt,
            input.maxTokens,
            input.messageId,
            controller.signal,
          ),
        );
      }
      return json(response, HTTP.notFound, { error: 'Not found' });
    })().catch((error: unknown) => demoError(response, error));
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
