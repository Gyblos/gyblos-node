const JAVASCRIPT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'] as const;

export const JAVASCRIPT_EXCEPTIONS: readonly string[] = [];

export function trackedPaths(listing: string): string[] {
  return listing.split('\0').filter(Boolean);
}

export function javascriptFiles(
  tracked: readonly string[],
  exceptions: readonly string[] = JAVASCRIPT_EXCEPTIONS,
): string[] {
  return tracked
    .filter((path) => {
      const name = path.toLowerCase();
      return (
        JAVASCRIPT_EXTENSIONS.some((extension) => name.endsWith(extension)) &&
        !exceptions.includes(path)
      );
    })
    .sort();
}
