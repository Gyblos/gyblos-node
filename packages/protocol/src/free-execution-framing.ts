// Reuses the canonical single-frame codec with separate free-execution bounds and typed errors.
// Call finish only after EOF; transport deadlines, admission and peer authentication remain external.
import { FREE_EXECUTION } from './constants';
import { ControlFrameReader, encodeControlFrame } from './control-framing';
import {
  parseFreeExecutionRequest,
  parseFreeExecutionResponse,
} from './free-execution';
import {
  freeExecutionBoundary,
  freeExecutionFail,
  rethrowFreeExecution,
} from './free-execution-validation';

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
class FreeExecutionReader<T> {
  private readonly reader: ControlFrameReader;
  private failed = false;
  constructor(
    maximum: number,
    private readonly parse: (value: unknown) => T,
  ) {
    this.reader = new ControlFrameReader(maximum);
  }
  private read<R>(operation: () => R): R {
    if (this.failed) return freeExecutionFail();
    try {
      return operation();
    } catch (error) {
      this.failed = true;
      return rethrowFreeExecution(error);
    }
  }
  push(chunk: Uint8Array) {
    return this.read(() => this.reader.push(chunk));
  }
  finish() {
    return this.read(() => this.parse(this.reader.finish()));
  }
}
export class FreeExecutionRequestReader extends FreeExecutionReader<
  ReturnType<typeof parseFreeExecutionRequest>
> {
  constructor() {
    super(FREE_EXECUTION.requestBytes, parseFreeExecutionRequest);
  }
}
export class FreeExecutionResponseReader extends FreeExecutionReader<
  ReturnType<typeof parseFreeExecutionResponse>
> {
  constructor() {
    super(FREE_EXECUTION.responseBytes, parseFreeExecutionResponse);
  }
}
