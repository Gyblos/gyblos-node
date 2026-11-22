// Balance the current test inventory using historical file durations from Linux CI.
const retiredBuyerCrashFiles = new Set([
  'tests/lab/channel-crash-native.test.ts',
  'tests/lab/channel-crash-boundaries.test.ts',
]);

export function assignShards(
  files: readonly string[],
  durations: ReadonlyMap<string, number>,
  count: number,
  ordinaryPr = false,
): string[][] {
  const paths = [...new Set(files)]
    .filter((path) => !ordinaryPr || !retiredBuyerCrashFiles.has(path))
    .sort();
  const measured = paths
    .flatMap((path) => durations.get(path) ?? [])
    .sort((a, b) => a - b);
  const fallback = measured[Math.floor(measured.length / 2)] ?? 1;
  paths.sort(
    (left, right) => (durations.get(right) ?? 0) - (durations.get(left) ?? 0),
  );

  const groups = Array.from({ length: count }, () => ({
    load: 0,
    files: new Array<string>(),
  }));
  for (const path of paths) {
    const group = groups.reduce((best, next) =>
      next.load < best.load ? next : best,
    );
    group.files.push(path);
    group.load += durations.get(path) ?? fallback;
  }
  return groups.map((group) => group.files.sort());
}
