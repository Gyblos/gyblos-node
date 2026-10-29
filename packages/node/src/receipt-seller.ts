// Records supplied seller observations through a bounded signer/store worker; never controls inference.
import {
  createFreeSellerReceipt,
  receiptTextSizes,
  type FreeSellerReceiptInput,
} from '@gyblos/core/receipts';
import {
  CONTROL_METERING_MODES,
  FREE_EXECUTION_CODES,
  RECEIPT_OUTCOMES,
  type EngineKind,
} from '@gyblos/protocol/constants';
import type {
  FreeExecutionRequest,
  FreeExecutionResponse,
} from '@gyblos/protocol/free-execution';
import type { Signer } from '@gyblos/protocol/signing';
import { createReceiptService } from '@gyblos/transport-iroh/receipt-service';

import { RECEIPT_WORK } from './constants';
import type { FreeMeter } from './free-meter';
import { receiptSignal } from './receipt-file';
import type { LocalReceiptStore } from './receipt-store';
import { createReceiptWork } from './receipt-work';

export interface SellerReceiptPublisher {
  publish(record: FreeSellerReceiptInput): void;
}
export interface SellerReceiptOptions {
  publisher: SellerReceiptPublisher;
  engineKind: EngineKind;
  clock?: () => number;
}
export function createSellerReceiptRuntime(options: {
  nodeId: string;
  store: LocalReceiptStore;
  signer: Signer;
}) {
  const work = createReceiptWork(RECEIPT_WORK.sellerMs);
  return {
    service: createReceiptService({
      nodeId: options.nodeId,
      store: options.store,
    }),
    publisher: {
      publish(record: FreeSellerReceiptInput) {
        void work
          .run(async (signal) => {
            const receipt = await createFreeSellerReceipt(
              record,
              options.signer,
            );
            receiptSignal(signal);
            await options.store.put(receipt, signal);
          })
          .catch(() => {});
      },
    },
    health: work.health,
    close: work.close,
    settled: work.settled,
  };
}
function sellerRecord(
  request: FreeExecutionRequest,
  digest: string,
  options: SellerReceiptOptions,
  meter: FreeMeter,
  streaming: boolean,
  receivedAt: number,
  response: FreeExecutionResponse,
  inputTokens: number,
  partial: string,
  first: number | null,
  total: number,
): FreeSellerReceiptInput | undefined {
  if (!response.result && meter.mode !== CONTROL_METERING_MODES.RECOUNTED)
    return undefined;
  const output = response.result?.text ?? partial;
  const offer = request.quote.offer;
  return {
    requestId: request.requestId,
    requestDigest: digest,
    sellerNodeId: offer.nodeId,
    buyerNodeId: offer.buyerNodeId,
    owner: offer.owner,
    selection: offer.selection,
    reasoning: offer.reasoning,
    engineKind: options.engineKind,
    metering: meter.mode,
    streaming,
    usage: {
      ...(response.result?.usage ?? {
        inputTokens,
        outputTokens: output ? meter.streamed(output) : 0,
      }),
      reasoningTokens: null,
    },
    sizes: receiptTextSizes(request.input.messages[0]!.content, output),
    timing: {
      receivedAt,
      firstTokenMs: output ? (first ?? total) : null,
      totalMs: total,
    },
    outcome: response.result
      ? RECEIPT_OUTCOMES.COMPLETED
      : response.error.code === FREE_EXECUTION_CODES.CANCELLED
        ? RECEIPT_OUTCOMES.CANCELLED
        : RECEIPT_OUTCOMES.FAILED,
    code: response.error?.code ?? null,
    reason: response.error?.reason ?? null,
    finishReason: response.result?.finishReason ?? null,
  };
}
export function sellerReceiptObservation(
  request: FreeExecutionRequest,
  digest: string,
  meter: FreeMeter,
  options: SellerReceiptOptions | undefined,
  streaming: boolean,
  receivedAt: number,
) {
  if (!options) return undefined;
  try {
    const clock = options.clock ?? (() => performance.now());
    const start = clock();
    let first: number | null = null;
    let inputTokens: number | undefined;
    let partial = '';
    let terminal = false;
    let usable = true;
    return {
      started(tokens: number) {
        inputTokens = tokens;
      },
      text(text: string) {
        try {
          if (!text || !usable) return;
          partial += text;
          first ??= Math.floor(clock() - start);
        } catch {
          usable = false;
          partial = '';
        }
      },
      finish(response: FreeExecutionResponse) {
        if (terminal) return;
        terminal = true;
        if (inputTokens === undefined || !usable) return;
        try {
          const record = sellerRecord(
            request,
            digest,
            options,
            meter,
            streaming,
            receivedAt,
            response,
            inputTokens,
            partial,
            first,
            Math.floor(clock() - start),
          );
          partial = '';
          if (record) options.publisher.publish(record);
        } catch {
          partial = ''; /* Receipt failures never alter the engine outcome. */
        }
      },
    };
  } catch {
    return undefined;
  }
}
