// Signed listing examples for the isolated preview.
import {
  CATALOG_STATE,
  type NetworkCatalog,
} from '@gyblos/desktop/network-catalog';

import { PREVIEW } from './constants';

const FIXTURE_PADDING = 56;
export function previewCatalog(
  model: string,
  now: number,
  search: string,
): NetworkCatalog {
  return {
    state: CATALOG_STATE.READY,
    query: search,
    checkedAt: now,
    truncated: false,
    // Several models, some offered by more than one seller, so grouping by model renders.
    models: [
      {
        modelId: model,
        variant: null,
        quantization: 'Q4_K_M',
        contextTokens: 16384,
        announcements: 1,
        expiresAt: now + PREVIEW.dayMs,
        free: true,
        inputAtomicPerMtok: '0',
        outputAtomicPerMtok: '0',
      },
      {
        modelId: model,
        variant: null,
        quantization: 'Q4_K_M',
        contextTokens: 32768,
        announcements: 1,
        expiresAt: now + PREVIEW.dayMs,
        free: false,
        offerId: '4b91' + '0'.repeat(FIXTURE_PADDING) + '1f32',
        sellerFingerprint: '4b91' + '0'.repeat(FIXTURE_PADDING) + '1f32',
        inputAtomicPerMtok: '52000',
        outputAtomicPerMtok: '208000',
      },
      {
        modelId: model,
        variant: null,
        quantization: 'Q4_K_M',
        contextTokens: 32768,
        announcements: 1,
        expiresAt: now + PREVIEW.dayMs,
        free: false,
        offerId: '83ce' + '0'.repeat(FIXTURE_PADDING) + 'a019',
        sellerFingerprint: '83ce' + '0'.repeat(FIXTURE_PADDING) + 'a019',
        inputAtomicPerMtok: '80000',
        outputAtomicPerMtok: '240000',
      },
      ...extraModels(now),
    ],
  };
}

// Desktop catalog bridge: an exact-model lookup returns only that model.
export function previewDesktopCatalog(model: string, now: number) {
  let catalogQuery = '';
  const catalogResult = () => {
    const result = previewCatalog(model, now, catalogQuery);
    if (!catalogQuery) return result;
    const models = result.models.filter(
      (item) => item.modelId === catalogQuery,
    );
    return models.length
      ? { ...result, models }
      : { ...result, state: CATALOG_STATE.EMPTY, models };
  };
  return {
    summary: async () => previewCatalog(model, now, ''),
    lookup: async (value: unknown) => {
      catalogQuery = typeof value === 'string' ? value.trim() : '';
      return catalogResult();
    },
  };
}

const seller = (head: string, tail: string) =>
  head + '0'.repeat(FIXTURE_PADDING) + tail;
function paidListing(
  modelId: string,
  fingerprint: string,
  quantization: string,
  input: string,
  output: string,
  now: number,
) {
  return {
    modelId,
    variant: null,
    quantization,
    contextTokens: 32768,
    announcements: 1,
    expiresAt: now + PREVIEW.dayMs,
    free: false,
    offerId: fingerprint,
    sellerFingerprint: fingerprint,
    inputAtomicPerMtok: input,
    outputAtomicPerMtok: output,
  };
}
function extraModels(now: number) {
  return [
    paidListing(
      'llama-3.2-3b',
      seller('4b91', '1f33'),
      'Q4_K_M',
      '60000',
      '180000',
      now,
    ),
    paidListing(
      'llama-3.2-3b',
      seller('c7d2', '5e10'),
      'Q8_0',
      '90000',
      '270000',
      now,
    ),
    paidListing(
      'gemma-3-4b',
      seller('83ce', 'a01a'),
      'Q4_K_M',
      '70000',
      '210000',
      now,
    ),
  ];
}
