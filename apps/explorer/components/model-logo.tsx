// Owns a model's maker mark: the family's monochrome icon drawn as a mask in the text color, so it
// follows the theme; a model of no known family shows its initial instead.
import type { ModelView } from '../lib/model-catalog';

const SIZES = {
  sm: { tile: 'size-5 rounded-md text-[10px]', mark: 'size-3.5' },
  lg: { tile: 'size-14 rounded-2xl text-xl', mark: 'size-9' },
} as const;

export function ModelLogo({
  modelId,
  view,
  size = 'sm',
}: {
  modelId: string;
  view: Pick<ModelView, 'family'>;
  size?: keyof typeof SIZES;
}) {
  const { family } = view;
  const { tile, mark } = SIZES[size];
  if (!family)
    return (
      <span
        aria-hidden
        className={`inline-flex shrink-0 items-center justify-center bg-raised font-mono text-muted uppercase ${tile}`}
      >
        {modelId.slice(0, 1)}
      </span>
    );
  const mask = `url(/models/${family}.svg) center / contain no-repeat`;
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center bg-raised ${tile}`}
    >
      <span className={`bg-ink ${mark}`} style={{ mask, WebkitMask: mask }} />
    </span>
  );
}
