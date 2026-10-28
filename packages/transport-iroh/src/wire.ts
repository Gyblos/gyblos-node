// Encodes and decodes the bounded HTTP/1-style wire format, keeping only allowlisted headers.
import { HTTP_STATUS, ROUTES } from '@gyblos/config';

import { HTTP_OVER_IROH } from './constants';
import type { HttpMessage, HttpRequest, HttpResponse } from './types';

const REQUEST_HEADERS = new Set(['content-type', 'payment-signature', 'host']);
const RESPONSE_HEADERS = new Set([
  'content-type',
  'payment-required',
  'payment-response',
]);

function encode(firstLine: string, message: HttpMessage) {
  const headers = Object.entries(message.headers).map(([name, value]) => {
    if (!/^[a-z-]+$/.test(name) || /[\r\n]/.test(value))
      throw new Error('Invalid HTTP header.');
    return `${name}: ${value}`;
  });
  const prefix = Buffer.from(
    [
      firstLine,
      ...headers,
      `content-length: ${message.body.length}`,
      'connection: close',
      '',
      '',
    ].join('\r\n'),
  );
  if (prefix.length > HTTP_OVER_IROH.headerBytes)
    throw new Error('HTTP headers exceed the limit.');
  return Buffer.concat([prefix, message.body]);
}

function decode(
  bytes: Uint8Array,
  limit: number,
  allowed: ReadonlySet<string>,
) {
  const buffer = Buffer.from(bytes);
  const boundary = buffer.indexOf('\r\n\r\n');
  if (
    boundary < 0 ||
    boundary > HTTP_OVER_IROH.headerBytes ||
    buffer.length - boundary - HTTP_OVER_IROH.headerTerminatorBytes > limit
  )
    throw new Error('HTTP frame exceeds its bounds.');
  const [firstLine, ...lines] = buffer
    .subarray(0, boundary)
    .toString('latin1')
    .split('\r\n');
  if (!firstLine || lines.length > HTTP_OVER_IROH.maxHeaders)
    throw new Error('Invalid HTTP header count.');
  const headers: Record<string, string> = {};
  const names = new Set<string>();
  let length: number | undefined;
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 1 || /^[ \t]/.test(line))
      throw new Error('Invalid HTTP header.');
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (
      !/^[a-z-]+$/.test(name) ||
      names.has(name) ||
      name === 'transfer-encoding'
    )
      throw new Error('Ambiguous HTTP framing.');
    names.add(name);
    if (name === 'content-length') {
      if (!/^\d+$/.test(value)) throw new Error('Invalid HTTP length.');
      length = Number(value);
    }
    if (allowed.has(name)) headers[name] = value;
    else if (!['content-length', 'connection', 'host'].includes(name))
      throw new Error('Unsupported HTTP header.');
  }
  const body = buffer.subarray(boundary + HTTP_OVER_IROH.headerTerminatorBytes);
  if (!Number.isSafeInteger(length) || length !== body.length)
    throw new Error('HTTP body length mismatch.');
  return { firstLine, headers, body };
}

export function encodeRequest(request: HttpRequest) {
  if (
    request.method !== 'POST' ||
    request.path !== ROUTES.inference ||
    request.body.length > HTTP_OVER_IROH.bodyBytes
  )
    throw new Error('Only bounded paid inference is exposed.');
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) =>
      REQUEST_HEADERS.has(name),
    ),
  );
  return encode(`POST ${ROUTES.inference} HTTP/1.1`, { ...request, headers });
}

export function decodeRequest(bytes: Uint8Array): HttpRequest {
  const message = decode(bytes, HTTP_OVER_IROH.bodyBytes, REQUEST_HEADERS);
  if (
    message.firstLine !== `POST ${ROUTES.inference} HTTP/1.1` ||
    message.headers['content-type'] !== 'application/json'
  )
    throw new Error('Only paid JSON inference is exposed.');
  return {
    method: 'POST',
    path: ROUTES.inference,
    headers: message.headers,
    body: message.body,
  };
}

export function encodeResponse(response: HttpResponse) {
  if (
    !Number.isInteger(response.status) ||
    response.status < HTTP_STATUS.ok ||
    response.status > HTTP_OVER_IROH.maxHttpStatus ||
    response.body.length > HTTP_OVER_IROH.responseBytes
  )
    throw new Error('Invalid bounded HTTP response.');
  const headers = Object.fromEntries(
    Object.entries(response.headers).filter(([name]) =>
      RESPONSE_HEADERS.has(name),
    ),
  );
  return encode(`HTTP/1.1 ${response.status} Result`, { ...response, headers });
}

export function decodeResponse(bytes: Uint8Array): HttpResponse {
  const message = decode(bytes, HTTP_OVER_IROH.responseBytes, RESPONSE_HEADERS);
  const match = /^HTTP\/1\.1 ([2-5]\d\d) Result$/.exec(message.firstLine);
  if (!match) throw new Error('Invalid HTTP response.');
  return {
    status: Number(match[1]),
    headers: message.headers,
    body: message.body,
  };
}
