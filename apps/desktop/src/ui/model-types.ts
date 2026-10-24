// Shared illustrative model presentation types; no live discovery contract is implied.
export type ModelArtwork = { src: string; monochrome?: boolean };
export type ChatModel = {
  id: string;
  name: string;
  image: ModelArtwork;
  free: boolean;
};
export type ModelOption = ChatModel & {
  input: number;
  output: number;
  family?: string;
};

export type CatalogModel = ModelOption & {
  family: string;
  category: (typeof import('./constants.js').MODEL_CATEGORY)[keyof typeof import('./constants.js').MODEL_CATEGORY];
  context: string;
  providers: number;
};
export type View =
  (typeof import('./constants.js').UI_VIEW)[keyof typeof import('./constants.js').UI_VIEW];
export type Mode = (typeof import('./constants.js').MODES)[number];
