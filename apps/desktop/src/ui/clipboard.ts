// Copies only caller-supplied text after a user action; never reads the clipboard.
import { COPY_RESULT } from './constants.js';

export { COPY_RESULT } from './constants.js';
export type ClipboardWriter = { writeText: (text: string) => Promise<void> };
export type CopyResult = (typeof COPY_RESULT)[keyof typeof COPY_RESULT];

export async function writeClipboardText(
  text: string,
  clipboard: ClipboardWriter | undefined,
): Promise<CopyResult> {
  if (!clipboard) return COPY_RESULT.UNAVAILABLE;
  try {
    await clipboard.writeText(text);
    return COPY_RESULT.COPIED;
  } catch {
    return COPY_RESULT.UNAVAILABLE;
  }
}
