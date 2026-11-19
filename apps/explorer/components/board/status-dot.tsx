// A 12 px status indicator, after BoardUI's StatusDot (MIT, see ./LICENSE): a solid dot on a tinted
// halo, in the signal blue (the brand blue on light surfaces, #2e6bff on dark ones).
export function StatusDot() {
  return (
    <span
      aria-hidden
      className="inline-flex size-3 shrink-0 items-center justify-center rounded-full bg-signal/20"
    >
      <span className="size-1.5 rounded-full bg-signal" />
    </span>
  );
}
