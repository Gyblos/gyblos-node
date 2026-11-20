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
    // One free and one paid example group, so both catalog rows render.
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
    ],
  };
}
