// Renders genuine model-family artwork consistently across the desktop concept.
// Images identify catalog entries visually; they do not attest provider authenticity.
import type { ModelArtwork } from './model-types.js';

export type { ModelArtwork } from './model-types.js';

export function ModelImage({
  artwork,
  name,
}: {
  artwork: ModelArtwork;
  name: string;
}) {
  return (
    <img
      className={'model-artwork' + (artwork.monochrome ? ' monochrome' : '')}
      src={artwork.src}
      data-model={name}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
