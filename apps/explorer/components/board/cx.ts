// Joins class names, skipping the falsy ones. Adapted from BoardUI's `cx` (MIT, see ./LICENSE).
export const cx = (...names: (string | false | null | undefined)[]) =>
  names.filter(Boolean).join(' ');
