// Owns a model's maker mark: the family's monochrome icon drawn as a mask in the text color, so it
// follows the theme; a model of no known family shows its initial instead.
import type { ModelView } from '../lib/model-catalog';

export function ModelLogo({
  modelId,
  view,
}: {
  modelId: string;
  view: Pick<ModelView, 'family' | 'familyName'>;
}) {
  const { family } = view;
  if (!family)
    return (
      <span
        aria-hidden
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-raised font-mono text-[10px] text-muted uppercase"
      >
        {modelId.slice(0, 1)}
      </span>
    );
  const mask = `url(/models/${family}.svg) center / contain no-repeat`;
  return (
    <span
      aria-hidden
      title={view.familyName ?? family}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-raised"
    >
      <span className="size-3.5 bg-ink" style={{ mask, WebkitMask: mask }} />
    </span>
  );
}
