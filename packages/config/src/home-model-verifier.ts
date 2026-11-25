import { join } from 'node:path';

import { homeLayout, type HomeEnvironment } from './home';

export const MODEL_VERIFIER_PATHS = {
  directory: 'model-verifier',
  key: 'verifier.key',
  results: 'results',
} as const;

export function modelVerifierLayout(environment: HomeEnvironment) {
  const root = join(
    homeLayout(environment).root,
    MODEL_VERIFIER_PATHS.directory,
  );
  return {
    root,
    key: join(root, MODEL_VERIFIER_PATHS.key),
    results: join(root, MODEL_VERIFIER_PATHS.results),
  } as const;
}
