// Reuses the canonical single-frame codec with separate free-execution bounds and typed errors.
// Call finish only after EOF; transport deadlines, admission and peer authentication remain external.
import { FREE_EXECUTION } from './constants.js';
import { ControlFrameReader, encodeControlFrame } from './control-framing.js';
import { freeExecutionBoundary } from './free-execution-validation.js';
import {
  parseFreeExecutionRequest,
  parseFreeExecutionResponse,
} from './free-execution.js';

export function encodeFreeExecutionRequest(value: unknown): Uint8Array {
  return freeExecutionBoundary(() =>
    encodeControlFrame(
      parseFreeExecutionRequest(value),
      FREE_EXECUTION.requestBytes,
    ),
  );
}
export function encodeFreeExecutionResponse(value: unknown): Uint8Array {
  return freeExecutionBoundary(() =>
    encodeControlFrame(
      parseFreeExecutionResponse(value),
      FREE_EXECUTION.responseBytes,
    ),
  );
}
export class FreeExecutionRequestReader {
  private readonly reader = new ControlFrameReader(FREE_EXECUTION.requestBytes);
  push(chunk: Uint8Array) {
    return freeExecutionBoundary(() => this.reader.push(chunk));
  }
  finish() {
    return freeExecutionBoundary(() =>
      parseFreeExecutionRequest(this.reader.finish()),
    );
  }
}
export class FreeExecutionResponseReader {
  private readonly reader = new ControlFrameReader(
    FREE_EXECUTION.responseBytes,
  );
  push(chunk: Uint8Array) {
    return freeExecutionBoundary(() => this.reader.push(chunk));
  }
  finish() {
    return freeExecutionBoundary(() =>
      parseFreeExecutionResponse(this.reader.finish()),
    );
  }
}
