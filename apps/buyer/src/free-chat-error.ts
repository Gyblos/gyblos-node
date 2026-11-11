// The local chat endpoint's refusals. `param` names the offending request field (an unsupported one only
// when it looks like a plain field name) and `detail` is fixed text or operator-configured values; neither
// carries the prompt.
import { FREE_BUYER_CODES, type FreeBuyerCode } from './constants';

export class FreeBuyerError extends Error {
  constructor(
    readonly code: FreeBuyerCode,
    readonly param: string | null = null,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'FreeBuyerError';
  }
}
export const invalidChat = (param: string | null, detail: string) =>
  new FreeBuyerError(FREE_BUYER_CODES.INVALID, param, detail);
