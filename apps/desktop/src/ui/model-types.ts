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
