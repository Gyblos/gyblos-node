// Owns base58 (the Bitcoin alphabet Solana uses) for instruction data and addresses read from RPC
// answers. Pure, no I/O; invalid text is refused rather than guessed.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const RADIX = 58;
const BYTE = 256;
const DIGIT_OF = new Map([...ALPHABET].map((char, digit) => [char, digit]));

export class Base58Error extends Error {
  constructor() {
    super('Invalid base58 text.');
    this.name = 'Base58Error';
  }
}

export function base58Decode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const digit = DIGIT_OF.get(char);
    if (digit === undefined) throw new Base58Error();
    let carry = digit;
    for (let index = 0; index < bytes.length; index++) {
      carry += bytes[index]! * RADIX;
      bytes[index] = carry % BYTE;
      carry = Math.floor(carry / BYTE);
    }
    while (carry) {
      bytes.push(carry % BYTE);
      carry = Math.floor(carry / BYTE);
    }
  }
  let zeros = 0;
  while (text[zeros] === ALPHABET[0]) zeros++;
  return Uint8Array.from([...Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index++) {
      carry += digits[index]! * BYTE;
      digits[index] = carry % RADIX;
      carry = Math.floor(carry / RADIX);
    }
    while (carry) {
      digits.push(carry % RADIX);
      carry = Math.floor(carry / RADIX);
    }
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return (
    ALPHABET[0]!.repeat(zeros) +
    digits
      .reverse()
      .map((digit) => ALPHABET[digit])
      .join('')
  );
}
