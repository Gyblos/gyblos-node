// Bounds raw terminal answer text in memory while filtering controls only from its live display.
import { FREE_EXECUTION } from '@gyblos/protocol/constants';

export function createChatText(write: (text: string) => void) {
  let text = '';
  let bytes = 0;
  return {
    append(value: unknown) {
      if (value === undefined) return;
      if (typeof value !== 'string' || /[\uD800-\uDFFF]/u.test(value))
        throw new Error('content');
      bytes += Buffer.byteLength(value);
      if (bytes > FREE_EXECUTION.outputBytes) throw new Error('bound');
      text += value;
      write(value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));
    },
    value: () => text,
  };
}
