// Shared illustrative model presentation types; no live discovery contract is implied.
import type { CatalogModelId } from '@gyblos/protocol/constants';

export type ModelArtwork = { src: string; monochrome?: boolean };
export type ChatModel = {
  id: string;
  catalogId?: CatalogModelId;
  name: string;
  image: ModelArtwork;
  free: boolean;
};
export type ModelOption = ChatModel & {
  input: number;
  output: number;
  family?: string;
  source?: (typeof import('./constants').MODEL_SOURCE)[keyof typeof import('./constants').MODEL_SOURCE];
};

export type CatalogModel = ModelOption & {
  family: string;
  category: (typeof import('./constants').MODEL_CATEGORY)[keyof typeof import('./constants').MODEL_CATEGORY];
  context: string;
  providers: number;
};
export type View =
  (typeof import('./constants').UI_VIEW)[keyof typeof import('./constants').UI_VIEW];
