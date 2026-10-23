// Encodes and incrementally reads one bounded canonical JSON frame; the caller supplies EOF and deadlines.
import { canonicalJson } from './canonical.js';
import { CONTROL_CODES, CONTROL_LIMITS } from './constants.js';
import { controlFail } from './control-validation.js';

function validateDepth(value: unknown) {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > CONTROL_LIMITS.depth)
      return controlFail(CONTROL_CODES.LIMIT);
    if (item.value && typeof item.value === 'object') {
      for (const key of Reflect.ownKeys(item.value)) {
        const descriptor = Object.getOwnPropertyDescriptor(item.value, key);
        if (typeof key !== 'string' || !descriptor || !('value' in descriptor))
          return controlFail();
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    }
  }
}
function canonicalControlJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return controlFail();
  }
}
export function encodeControlFrame(
  value: unknown,
  maximum: number = CONTROL_LIMITS.requestBytes,
): Uint8Array {
  validateDepth(value);
  const body = new TextEncoder().encode(canonicalControlJson(value));
  if (body.length > maximum) return controlFail(CONTROL_CODES.LIMIT);
  const frame = new Uint8Array(CONTROL_LIMITS.prefixBytes + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, CONTROL_LIMITS.prefixBytes);
  return frame;
}
export class ControlFrameReader {
  private readonly prefix = new Uint8Array(CONTROL_LIMITS.prefixBytes);
  private prefixSize = 0;
  private body: Uint8Array | undefined;
  private size = 0;
  private ended = false;
  constructor(private readonly maximum: number = CONTROL_LIMITS.requestBytes) {}
  push(chunk: Uint8Array) {
    if (this.ended) return controlFail();
    let offset = 0;
    while (this.prefixSize < this.prefix.length && offset < chunk.length)
      this.prefix[this.prefixSize++] = chunk[offset++]!;
    if (this.prefixSize === this.prefix.length && !this.body) {
      const length = new DataView(this.prefix.buffer).getUint32(0);
      if (!length || length > this.maximum)
        return controlFail(CONTROL_CODES.LIMIT);
      this.body = new Uint8Array(length);
    }
    if (!this.body) return;
    const remaining = chunk.length - offset;
    if (remaining > this.body.length - this.size) return controlFail();
    this.body.set(chunk.subarray(offset), this.size);
    this.size += remaining;
  }
  finish(): unknown {
    if (this.ended) return controlFail();
    this.ended = true;
    if (!this.body || this.size !== this.body.length) return controlFail();
    let text: string;
    let value: unknown;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        this.body,
      );
      value = JSON.parse(text);
    } catch {
      return controlFail();
    }
    validateDepth(value);
    if (canonicalControlJson(value) !== text) return controlFail();
    return value;
  }
}
