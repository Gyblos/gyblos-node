import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function paypalSandboxPaths(root: string) {
  return {
    directory: root,
    state: join(root, 'paypal-sandbox-v1.json'),
    lock: join(root, 'paypal-sandbox-v1.lock'),
    reviewDirectory: join(root, 'paypal-sandbox-reviews-v1'),
  };
}
export function paypalSandboxReviewPaths(root: string, requestId: string) {
  const digest = createHash('sha256').update(requestId).digest('hex');
  const directory = paypalSandboxPaths(root).reviewDirectory;
  return {
    decision: join(directory, `${digest}-decision.json`),
    outcome: join(directory, `${digest}-outcome.json`),
  };
}

export function paypalSandboxVoidExceptionPath(
  root: string,
  requestId: string,
) {
  const digest = createHash('sha256').update(requestId).digest('hex');
  return join(
    paypalSandboxPaths(root).reviewDirectory,
    `${digest}-void-sandbox-exception.json`,
  );
}
