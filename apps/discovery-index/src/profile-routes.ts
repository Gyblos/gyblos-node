import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { isJsonContentType } from './body';
import {
  DISCOVERY_LIMITERS,
  INDEX_ERRORS,
  INDEX_HEADERS,
  INDEX_ROUTES,
  INDEX_STATUS,
  SELLER_PROFILE,
} from './constants';
import { IndexError, indexFail } from './errors';
import {
  parseProfilePath,
  sellerProfilePage,
  submitSellerProfile,
} from './profiles';
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
    const { profiles } = settings;
    if (!profiles) return rejection(context, INDEX_ERRORS.UNAVAILABLE);
    if (!(await clientAllowed(context, DISCOVERY_LIMITERS.PUBLISH)))
      return rejection(context, INDEX_ERRORS.RATE_LIMITED);
    if (!isJsonContentType(context.req.header(INDEX_HEADERS.CONTENT_TYPE)))
      return rejection(context, INDEX_ERRORS.INVALID_CLAIM);
    const bytes = await context.req.arrayBuffer();
    if (bytes.byteLength > SELLER_PROFILE.maxBodyBytes)
      return rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE);
    try {
      const result = await submitSellerProfile(bytes, {
        profiles,
        storage: context.get('storage'),
        registrations: settings.registrations,
        now: settings.now(),
      });
      return context.json({ ok: true, ...result }, INDEX_STATUS.OK);
    } catch (error) {
      if (error instanceof IndexError) return rejection(context, error.code);
      throw error;
    }
  };
}

export function profileRoutes(app: Hono<IndexEnv>, settings: IndexSettings) {
  app.post(
    INDEX_ROUTES.PROFILE,
    bodyLimit({
      maxSize: SELLER_PROFILE.maxBodyBytes,
      onError: (context) => rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE),
    }),
    submitHandler(settings),
  );
  app.get(
    `${INDEX_ROUTES.PROFILE}/:nodeId`,
    cachedRead(settings, async (context) => {
      const { profiles } = settings;
      if (!profiles) return indexFail(INDEX_ERRORS.UNAVAILABLE);
      const nodeId = parseProfilePath(
        context.req.url,
        context.req.param('nodeId'),
      );
      const { origin } = new URL(context.req.url);
      return {
        key: `${origin}${INDEX_ROUTES.PROFILE}/${nodeId}`,
        missing: INDEX_ERRORS.NO_PROFILE,
        body: () =>
          sellerProfilePage(
            {
              profiles,
              storage: context.get('storage'),
              registrations: settings.registrations,
            },
            nodeId,
          ),
      };
    }),
  );
}
