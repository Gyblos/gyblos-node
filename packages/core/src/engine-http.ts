// Bounded readers for engine adapters that speak HTTP: a whole response body with a byte cap, and a
// server-sent event stream as the data of each event with per-event and per-stream caps. Malformed UTF-8
// is a frame failure and anything over a cap a bound failure, so adapters classify both through
// engine-failures. Pure; web streams only.
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

export interface ServerSentLimits {
  // One event's data, or a line still pending.
  eventCharacters: number;
  // Everything the stream may carry, comments and ignored fields included.
  streamCharacters: number;
}

// The index of the next line end at or after from, or -1.
function lineEnd(buffer: string, from: number) {
  for (let index = from; index < buffer.length; index++) {
    const character = buffer[index];
    if (character === '\n' || character === '\r') return index;
  }
  return -1;
}

// Splits SSE lines into events: an event's data lines joined by newlines, finished by a blank line;
// comments and other fields are ignored.
class EventLines {
  private data: string[] = [];
  private size = 0;
  constructor(private readonly maxCharacters: number) {}
  // The finished event's data, if this line ended one.
  read(line: string): string | undefined {
    if (!line) {
      const event = this.data.length ? this.data.join('\n') : undefined;
      this.data = [];
      this.size = 0;
      return event;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    if ((colon === -1 ? line : line.slice(0, colon)) !== 'data')
      return undefined;
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    this.size += value.length;
    if (this.size > this.maxCharacters) throw new BoundFailure();
    this.data.push(value);
    return undefined;
  }
}

// Server-sent events from a body; the end of the body ends the last event. Lines are read by offset
// and every received character is scanned for line ends once; a long pending line still costs its
// length per chunk to join and keep, which the caps bound. An event or pending line over
// eventCharacters, or a stream over streamCharacters, is a bound failure.
export async function* serverSentData(
  body: ReadableStream<Uint8Array>,
  limits: ServerSentLimits,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = body.getReader();
  const events = new EventLines(limits.eventCharacters);
  let buffer = '';
  // Where the next scan starts: everything before it holds no line end.
  let scanned = 0;
  let received = 0;
  try {
    for (;;) {
      const part = await reader.read();
      let text: string;
      try {
        text = decoder.decode(part.value, { stream: !part.done });
      } catch {
        throw new FrameFailure();
      }
      received += text.length;
      if (received > limits.streamCharacters) throw new BoundFailure();
      buffer += part.done ? `${text}\n\n` : text;
      let start = 0;
      let end: number;
      while ((end = lineEnd(buffer, Math.max(start, scanned))) !== -1) {
        // A trailing CR may be the first half of CRLF still in flight.
        if (!part.done && end === buffer.length - 1 && buffer[end] === '\r')
          break;
        const line = buffer.slice(start, end);
        start = end + (buffer.startsWith('\r\n', end) ? 2 : 1);
        const event = events.read(line);
        if (event !== undefined) yield event;
      }
      buffer = buffer.slice(start);
      // A held CR is the last character and is scanned again with the next chunk.
      scanned = Math.max(0, buffer.length - 1);
      if (buffer.length > limits.eventCharacters) throw new BoundFailure();
      if (part.done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
