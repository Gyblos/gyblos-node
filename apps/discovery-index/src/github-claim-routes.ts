// Owns the HTTP wiring of seller GitHub claims: POST /v1/identity/github (limited and size-capped like a
// registration, since it spends a request to GitHub) and the cached public GET of one claim. Without a
// claim store or a fetcher both answer 503; behavior lives in github-claims.ts.
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { isJsonContentType } from './body';
import {
  DISCOVERY_LIMITERS,
  GITHUB_CLAIM,
  INDEX_ERRORS,
  INDEX_HEADERS,
  INDEX_ROUTES,
  INDEX_STATUS,
} from './constants';
import { IndexError, indexFail } from './errors';
import {
  githubClaimPage,
  parseGithubClaimPath,
  submitGithubClaim,
  type GithubClaimResult,
} from './github-claims';
import {
  cachedRead,
  clientAllowed,
  rejection,
  type IndexContext,
  type IndexEnv,
} from './routing';
import type { IndexSettings } from './settings';

function submitHandler(settings: IndexSettings) {
  return async (context: IndexContext) => {
    const { claims, gistFetch } = settings;
    if (!claims || !gistFetch)
      return rejection(context, INDEX_ERRORS.UNAVAILABLE);
    if (!(await clientAllowed(context, DISCOVERY_LIMITERS.PUBLISH)))
      return rejection(context, INDEX_ERRORS.RATE_LIMITED);
    if (!isJsonContentType(context.req.header(INDEX_HEADERS.CONTENT_TYPE)))
      return rejection(context, INDEX_ERRORS.INVALID_CLAIM);
    const bytes = await context.req.arrayBuffer();
    if (bytes.byteLength > GITHUB_CLAIM.maxBodyBytes)
      return rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE);
    let result: GithubClaimResult;
    try {
      result = await submitGithubClaim(bytes, {
        claims,
        storage: context.get('storage'),
        registrations: settings.registrations,
        fetch: gistFetch,
        now: settings.now(),
      });
    } catch (error) {
      if (error instanceof IndexError) return rejection(context, error.code);
      throw error;
    }
    return context.json({ ok: true, ...result }, INDEX_STATUS.OK);
  };
}

export function githubClaimRoutes(
  app: Hono<IndexEnv>,
  settings: IndexSettings,
) {
  app.post(
    INDEX_ROUTES.GITHUB_IDENTITY,
    bodyLimit({
      maxSize: GITHUB_CLAIM.maxBodyBytes,
      onError: (context) => rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE),
    }),
    submitHandler(settings),
  );
  app.get(
    `${INDEX_ROUTES.GITHUB_IDENTITY}/:nodeId`,
    cachedRead(settings, async (context) => {
      const { claims } = settings;
      if (!claims) return indexFail(INDEX_ERRORS.UNAVAILABLE);
      const nodeId = parseGithubClaimPath(
        context.req.url,
        context.req.param('nodeId'),
      );
      const { origin } = new URL(context.req.url);
      return {
        key: `${origin}${INDEX_ROUTES.GITHUB_IDENTITY}/${nodeId}`,
        body: () => githubClaimPage(claims, nodeId),
      };
    }),
  );
}
