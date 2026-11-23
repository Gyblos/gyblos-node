const JAVASCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;

export const JAVASCRIPT_EXCEPTIONS: readonly string[] = [];

export function javascriptFiles(
  tracked: readonly string[],
  exceptions: readonly string[] = JAVASCRIPT_EXCEPTIONS,
): string[] {
  return tracked
    .filter(
      (path) =>
        JAVASCRIPT_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
        !exceptions.includes(path),
    )
    .sort();
}
