// Bounded readers for engine adapters that speak HTTP: a whole response body with a byte cap, and a
// server-sent event stream as the data of each event with a per-event cap. Malformed UTF-8 is a frame
// failure and anything over a cap a bound failure, so adapters classify both through engine-failures.
// Pure; web streams only.
import { BoundFailure, FrameFailure } from './engine-failures';

// The body as UTF-8 text, refused once it exceeds maxBytes.
export async function boundedText(response: Response, maxBytes: number) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.byteLength;
      if (received > maxBytes) throw new BoundFailure();
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof BoundFailure) throw error;
    throw new FrameFailure();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Server-sent events: yields each event's data lines joined by newlines, ignoring comments and other
// fields; the end of the body ends the last event. An event or pending line longer than
// maxEventCharacters is a bound failure.
export async function* serverSentData(
  body: ReadableStream<Uint8Array>,
  maxEventCharacters: number,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = body.getReader();
  let buffer = '';
  let data: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      try {
        buffer += decoder.decode(part.value, { stream: !part.done });
      } catch {
        throw new FrameFailure();
      }
      // The end of the body ends its last line and dispatches its last event.
      if (part.done) buffer += '\n\n';
      let end: number;
      while ((end = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // A trailing CR may be the first half of CRLF still in flight.
        if (!part.done && end === buffer.length - 1 && buffer[end] === '\r')
          break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer.startsWith('\r\n', end) ? 2 : 1));
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
          size = 0;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        if ((colon === -1 ? line : line.slice(0, colon)) !== 'data') continue;
        const value =
          colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        size += value.length;
        if (size > maxEventCharacters) throw new BoundFailure();
        data.push(value);
      }
      if (buffer.length > maxEventCharacters) throw new BoundFailure();
      if (part.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
