// Owns bounded model input from committed blobs; source is never executed or mounted in Pi.
import {
  MAX_BUNDLE_BYTES,
  MAX_RESPONSE_ITEMS,
  REVIEW_VALUES,
} from './constants';
import { sourceDiff, trackedFile, UnsupportedSourceError } from './git';
import { reviewableFiles } from './inventory';
import type { ReviewPlan, SourceBundle } from './types';

export async function createSourceBundle(
  root: string,
  plan: ReviewPlan,
  paths: string[],
): Promise<SourceBundle> {
  const bundle: SourceBundle = {
    files: [],
    diff: '',
    omissions: [],
    excluded: [],
  };
  const safePaths = reviewableFiles(paths);
  for (const path of paths) {
    if (!safePaths.includes(path))
      bundle.omissions.push({
        path,
        reason: 'Excluded private or unsupported path.',
      });
  }
  for (const path of safePaths) {
    for (const revision of [REVIEW_VALUES.HEAD, REVIEW_VALUES.BASE] as const) {
      const ref =
        revision === REVIEW_VALUES.HEAD ? plan.sourceRef : plan.baseRef;
      if (
        !ref ||
        (revision === REVIEW_VALUES.BASE && !plan.changedFiles.includes(path))
      )
        continue;
      try {
        const text = await trackedFile(root, ref, path);
        if (text !== undefined) bundle.files.push({ path, revision, text });
      } catch (error) {
        if (error instanceof UnsupportedSourceError) {
          if (!bundle.excluded.some((entry) => entry.path === path))
            bundle.excluded.push({
              path,
              reason: 'Symlink, submodule or binary blob; not text source.',
            });
        } else
          bundle.omissions.push({
            path,
            reason: 'Source blob is unreadable or over its limit.',
          });
      }
    }
  }
  if (plan.baseRef) {
    try {
      bundle.diff = await sourceDiff(
        root,
        plan.baseRef,
        plan.sourceRef,
        safePaths.filter((path) => plan.changedFiles.includes(path)),
      );
    } catch {
      bundle.omissions.push({
        path: '(diff)',
        reason: 'Diff unavailable or over its byte limit.',
      });
    }
  }
  return bundle;
}

export function partitionBundle(bundle: SourceBundle): SourceBundle[] {
  const parts: SourceBundle[] = [];
  let current: SourceBundle = {
    files: [],
    diff: bundle.diff,
    omissions: bundle.omissions,
    excluded: bundle.excluded,
  };
  for (const file of bundle.files) {
    const proposed = { ...current, files: [...current.files, file] };
    if (
      (Buffer.byteLength(JSON.stringify(proposed), 'utf8') > MAX_BUNDLE_BYTES ||
        new Set(proposed.files.map((file) => file.path)).size >
          MAX_RESPONSE_ITEMS) &&
      current.files.length
    ) {
      parts.push(current);
      current = {
        files: [],
        diff: bundle.diff,
        omissions: bundle.omissions,
        excluded: bundle.excluded,
      };
    }
    current.files.push(file);
    if (Buffer.byteLength(JSON.stringify(current), 'utf8') > MAX_BUNDLE_BYTES)
      current.omissions = [
        ...current.omissions,
        { path: file.path, reason: 'Single file exceeds the prompt budget.' },
      ];
  }
  if (current.files.length || !parts.length) parts.push(current);
  return parts;
}
