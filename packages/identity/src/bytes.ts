// Owns Borsh-style primitive encoding and a bounds-checked reader for account data.
// Must not know any 8004 account layout or instruction; callers compose these.
import { IDENTITY_ERROR_CODES } from './constants.js';
import { IdentityError } from './errors.js';

const U32_BYTES = 4;
const I64_BYTES = 8;
const UTF8 = new TextEncoder();
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return UTF8.encode(text);
}

export function encodeU32(value: number): Uint8Array {
  const out = new Uint8Array(U32_BYTES);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function encodeI64(value: bigint): Uint8Array {
  const out = new Uint8Array(I64_BYTES);
  new DataView(out.buffer).setBigInt64(0, value, true);
  return out;
}

export function encodeBool(value: boolean): Uint8Array {
  return Uint8Array.of(value ? 1 : 0);
}

export function encodeVecU8(bytes: Uint8Array): Uint8Array {
  return concatBytes([encodeU32(bytes.length), bytes]);
}

export function encodeString(text: string): Uint8Array {
  return encodeVecU8(utf8(text));
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function invalid(message: string): IdentityError {
  return new IdentityError(IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID, message);
}

export class ByteReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  bytes(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.data.length)
      throw invalid(`read past end at ${this.offset}`);
    const out = this.data.subarray(this.offset, end);
    this.offset = end;
    return out;
  }

  skip(length: number): void {
    this.bytes(length);
  }

  u8(): number {
    return this.bytes(1)[0] ?? 0;
  }

  u32(): number {
    const raw = this.bytes(U32_BYTES);
    return new DataView(raw.buffer, raw.byteOffset, U32_BYTES).getUint32(
      0,
      true,
    );
  }

  bool(): boolean {
    const tag = this.u8();
    if (tag > 1) throw invalid(`bool tag ${tag} at ${this.offset - 1}`);
    return tag === 1;
  }

  option<T>(readSome: () => T): T | undefined {
    return this.bool() ? readSome() : undefined;
  }

  vecU8(maxLength: number): Uint8Array {
    const length = this.u32();
    if (length > maxLength) throw invalid(`length ${length} > ${maxLength}`);
    return this.bytes(length);
  }

  string(maxLength: number): string {
    const raw = this.vecU8(maxLength);
    try {
      return STRICT_UTF8.decode(raw);
    } catch (cause) {
      throw new IdentityError(
        IDENTITY_ERROR_CODES.ACCOUNT_DATA_INVALID,
        'string is not valid UTF-8',
        { cause },
      );
    }
  }
}
