// Owns strict decoding of a publish body into its signed envelope and that envelope's verbatim text, and
// the strict UTF-8 and JSON steps other bodies share. It must not verify records (protocol does) or echo
// input; every publish failure is INVALID_RECORD.
import {
  DISCOVERY_INDEX_LIMITS,
  INDEX_ERRORS,
  type IndexErrorCode,
} from './constants';
import { indexFail } from './errors';

export interface PublishBody {
  // The signed envelope `{ record, signature }`, still unverified.
  envelope: unknown;
  // Its exact compact text as posted, which the index stores and serves byte-for-byte.
  json: string;
}

const CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
// The body is exactly one `record` member; whitespace around it is not stored.
const BODY_SHAPE =
  /^[ \t\n\r]*\{[ \t\n\r]*"record"[ \t\n\r]*:([^]*)\}[ \t\n\r]*$/;
const TRAILING_SPACE = /[ \t\n\r]+$/;

export function isJsonContentType(value: string | undefined) {
  return CONTENT_TYPE.test(value ?? '');
}

export function decodeUtf8(
  bytes: ArrayBuffer,
  code: IndexErrorCode = INDEX_ERRORS.INVALID_RECORD,
): string {
  try {
    // ignoreBOM keeps a BOM in the text, so JSON parsing rejects it.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return indexFail(code);
  }
}

export function parseJson(
  text: string,
  code: IndexErrorCode = INDEX_ERRORS.INVALID_RECORD,
): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return indexFail(code);
  }
}

// Iterative, so hostile nesting cannot overflow the stack before it is rejected.
function checkDepth(value: unknown) {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > DISCOVERY_INDEX_LIMITS.maxJsonDepth) indexFail();
    if (item.value && typeof item.value === 'object')
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
  }
}

// JSON.stringify's compact form in the value's own member order: no whitespace and minimal
// escapes. Only JSON data with safe integers is representable, as in signed records.
export function compactJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && !Object.is(value, -0)
      ? JSON.stringify(value)
      : indexFail();
  if (Array.isArray(value)) return `[${value.map(compactJson).join(',')}]`;
  if (typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}:${compactJson(item)}`)
      .join(',')}}`;
  return indexFail();
}

// Re-serializing and comparing with the posted text rejects duplicate members, padding,
// needless escapes, non-canonical or unsafe numbers and `-0`, which JSON.parse alone accepts.
export function readPublishBody(bytes: ArrayBuffer): PublishBody {
  const text = decodeUtf8(bytes);
  const body = parseJson(text);
  checkDepth(body);
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, 'record')
  )
    indexFail();
  const envelope: unknown = Reflect.get(body, 'record');
  const json = compactJson(envelope);
  const posted = BODY_SHAPE.exec(text)?.[1]?.replace(TRAILING_SPACE, '');
  if (posted?.trimStart() !== json) indexFail();
  return { envelope, json };
}
