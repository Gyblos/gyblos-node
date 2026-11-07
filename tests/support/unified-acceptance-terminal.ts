// Coordinates the scripted user's receipt wait with its pending terminal input; no buyer or native I/O.
import type { Writable } from 'node:stream';

export async function finishReceiptWait(
  input: Writable,
  controller: AbortController,
  wait: Promise<void>,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    await wait;
    input.write('/exit\n');
    return { ok: true };
  } catch (error) {
    input.end();
    return { ok: false, error };
  }
}
