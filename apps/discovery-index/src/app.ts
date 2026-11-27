// Owns the discovery index HTTP app: an untrusted cache of node-signed public v2 records.
// It never vouches for identity, never stores or logs IPs and answers only static error codes.
import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { SELLER_VERSION } from '@gyblos/protocol/constants';

import { isJsonContentType } from './body';
import { sellersCacheKey } from './cache';
import {
  DISCOVERY_INDEX_LIMITS,
  DISCOVERY_LIMITERS,
  INDEX_ERRORS,
  INDEX_HEADER_VALUES,
  INDEX_HEADERS,
  INDEX_PROTOCOLS,
  INDEX_ROUTES,
  INDEX_STATUS,
  LOOPBACK_HOSTS,
  PUBLIC_READ_PREFIXES,
  PUBLIC_READ_ROUTES,
  REDEEM_RESULTS,
  REGISTRATION,
  REGISTRATION_STATUS,
  type RedeemResult,
} from './constants';
import { IndexError } from './errors';
import { githubClaimRoutes } from './github-claim-routes';
import { allowed } from './limits';
import { modelCatalogPage, modelsPage, parseModelsQuery } from './models';
import { networkPage, parseNetworkQuery } from './network';
import {
  networkHistoryKey,
  networkHistoryPage,
  parseNetworkHistoryQuery,
} from './network-history';
import {
  offerHistoryKey,
  offerHistoryPage,
  parseOfferHistoryQuery,
} from './offer-history';
import { profileRoutes } from './profile-routes';
import { acceptRecord, type PublishContext } from './publish';
import { publishModeOf } from './publishers';
import type { RegistrationStore } from './registration-store';
import { registerSeller, type RegistryReader } from './registrations';
import {
  cachedRead,
  clientAllowed,
  clientKey,
  readAllowed,
  rejection,
  type IndexContext,
  type IndexEnv,
} from './routing';
import { parseSellersQuery, sellersPage } from './sellers';
import {
  settingsOf,
  type DiscoveryIndexOptions,
  type IndexSettings,
} from './settings';
import { parseUptimeQuery, uptimePage } from './uptime';
import { versionsPage } from './versions';

export type { ResponseCache } from './cache';
export type { DiscoveryIndexOptions } from './settings';

function finishHeaders(context: Context) {
  const headers = context.res.headers;
  if (!headers.has(INDEX_HEADERS.CACHE_CONTROL))
    headers.set(INDEX_HEADERS.CACHE_CONTROL, INDEX_HEADER_VALUES.NO_STORE);
  const read = context.req.method === 'GET' || context.req.method === 'HEAD';
  const path = context.req.path;
  const publicRead =
    PUBLIC_READ_ROUTES.has(path) ||
    PUBLIC_READ_PREFIXES.some((prefix) => path.startsWith(prefix));
  if (read && publicRead)
    headers.set(INDEX_HEADERS.CORS_ORIGIN, INDEX_HEADER_VALUES.ANY_ORIGIN);
  headers.set(INDEX_HEADERS.ROBOTS, INDEX_HEADER_VALUES.NOINDEX);
  headers.set(INDEX_HEADERS.CONTENT_TYPE_OPTIONS, INDEX_HEADER_VALUES.NOSNIFF);
}

// https only; development apps also accept plain http on a loopback host.
function secureRequest(url: string, development: boolean) {
  const { protocol, hostname } = new URL(url);
  return (
    protocol === INDEX_PROTOCOLS.SECURE ||
    (development &&
      protocol === INDEX_PROTOCOLS.LOOPBACK &&
      LOOPBACK_HOSTS.has(hostname))
  );
}

// Before routing: https, then fail closed on storage and every limiter, then the per-IP(/64) limit.
function admitRequest(settings: IndexSettings) {
  return async (context: IndexContext, next: Next) => {
    const limiters = settings.resolve(context.req.url);
    if (!secureRequest(context.req.url, settings.development))
      context.res = rejection(context, INDEX_ERRORS.HTTPS_REQUIRED);
    else if (!settings.storage || !limiters)
      context.res = rejection(context, INDEX_ERRORS.UNAVAILABLE);
    else if (
      !(await allowed(limiters[DISCOVERY_LIMITERS.IP], clientKey(context)))
    )
      context.res = rejection(context, INDEX_ERRORS.RATE_LIMITED);
    else {
      context.set('storage', settings.storage);
      context.set('limiters', limiters);
      await next();
    }
    finishHeaders(context);
  };
}

function publishHandler(settings: IndexSettings) {
  return async (context: IndexContext) => {
    if (!(await clientAllowed(context, DISCOVERY_LIMITERS.PUBLISH)))
      return rejection(context, INDEX_ERRORS.RATE_LIMITED);
    if (!isJsonContentType(context.req.header(INDEX_HEADERS.CONTENT_TYPE)))
      return rejection(context, INDEX_ERRORS.INVALID_RECORD);
    const bytes = await context.req.arrayBuffer();
    if (bytes.byteLength > DISCOVERY_INDEX_LIMITS.maxBodyBytes)
      return rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE);
    const publish: PublishContext = {
      storage: context.get('storage'),
      publishers: settings.publishers,
      registrations: settings.registrations,
      now: settings.now(),
      maxNodes: settings.maxNodes,
      maxPublications: context.get('limiters').maxNodePublications,
      prune: settings.prune,
      markSeen: settings.markSeen,
    };
    try {
      await acceptRecord(
        bytes,
        publish,
        context.req.header(SELLER_VERSION.header),
      );
    } catch (error) {
      if (error instanceof IndexError) return rejection(context, error.code);
      throw error;
    }
    settings.records.reset();
    return context.json({ ok: true }, INDEX_STATUS.CREATED);
  };
}

// Rare and spends an invite or an RPC read: limited like a publish, per IP(/64).
function registrationHandler(
  settings: IndexSettings,
  registrations: RegistrationStore,
  registry: RegistryReader,
) {
  return async (context: IndexContext) => {
    if (!(await clientAllowed(context, DISCOVERY_LIMITERS.PUBLISH)))
      return rejection(context, INDEX_ERRORS.RATE_LIMITED);
    if (!isJsonContentType(context.req.header(INDEX_HEADERS.CONTENT_TYPE)))
      return rejection(context, INDEX_ERRORS.INVALID_REGISTRATION);
    const bytes = await context.req.arrayBuffer();
    if (bytes.byteLength > REGISTRATION.maxBodyBytes)
      return rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE);
    let result: RedeemResult;
    try {
      result = await registerSeller(bytes, {
        store: registrations,
        registry,
        now: settings.now(),
        country: context.get('country'),
      });
    } catch (error) {
      if (error instanceof IndexError) return rejection(context, error.code);
      throw error;
    }
    return context.json(
      { ok: true, status: REGISTRATION_STATUS.ACTIVE },
      result === REDEEM_RESULTS.REGISTERED
        ? INDEX_STATUS.CREATED
        : INDEX_STATUS.OK,
    );
  };
}

// Cloudflare's country for the request (request.cf.country), when the Worker runtime provides it.
function requestCountry(context: IndexContext): unknown {
  const cf: unknown = Reflect.get(context.req.raw, 'cf');
  return cf && typeof cf === 'object' ? Reflect.get(cf, 'country') : undefined;
}

// The public reads with a body: sellers pages, the model list, seller uptime and the network.
function readRoutes(app: Hono<IndexEnv>, settings: IndexSettings) {
  app.get(
    INDEX_ROUTES.SELLERS,
    cachedRead(settings, async (context) => {
      const query = await parseSellersQuery(context.req.url);
      return {
        key: sellersCacheKey(context.req.url, query),
        body: () =>
          sellersPage(
            context.get('storage'),
            query,
            settings.now(),
            settings.maxResponseBytes,
          ),
      };
    }),
  );
  app.get(
    INDEX_ROUTES.MODELS,
    cachedRead(settings, async (context) => {
      parseModelsQuery(context.req.url);
      const url = new URL(context.req.url);
      return {
        key: `${url.origin}${INDEX_ROUTES.MODELS}`,
        body: () => modelsPage(context.get('storage'), settings.now()),
      };
    }),
  );
  app.get(
    INDEX_ROUTES.MODEL_CATALOG,
    cachedRead(settings, async (context) => {
      parseModelsQuery(context.req.url);
      const url = new URL(context.req.url);
      return {
        key: `${url.origin}${INDEX_ROUTES.MODEL_CATALOG}`,
        body: () => modelCatalogPage(context.get('storage'), settings),
      };
    }),
  );
  app.get(
    INDEX_ROUTES.VERSIONS,
    cachedRead(settings, async (context) => {
      const url = new URL(context.req.url);
      const node = url.search ? parseUptimeQuery(context.req.url) : undefined;
      return {
        key: url.origin + INDEX_ROUTES.VERSIONS + (node ? '?node=' + node : ''),
        body: () =>
          versionsPage(
            context.get('storage'),
            settings.now(),
            settings.maxResponseBytes,
            node,
          ),
      };
    }),
  );
  app.get(
    INDEX_ROUTES.UPTIME,
    cachedRead(settings, async (context) => {
      const node = parseUptimeQuery(context.req.url);
      // One cache entry per NodeId, whatever equivalent spelling the query used.
      const { origin } = new URL(context.req.url);
      return {
        key: `${origin}${INDEX_ROUTES.UPTIME}?node=${node}`,
        body: () => uptimePage(context.get('storage'), node, settings.now()),
      };
    }),
  );
  app.get(
    INDEX_ROUTES.NETWORK,
    cachedRead(settings, async (context) => {
      parseNetworkQuery(context.req.url);
      const { origin } = new URL(context.req.url);
      return {
        key: `${origin}${INDEX_ROUTES.NETWORK}`,
        body: () =>
          networkPage(
            context.get('storage'),
            settings.registrations,
            { claims: settings.claims, profiles: settings.profiles },
            settings.now(),
            settings.maxResponseBytes,
          ),
      };
    }),
  );
}

function historyRoutes(app: Hono<IndexEnv>, settings: IndexSettings) {
  app.get(
    INDEX_ROUTES.NETWORK_HISTORY,
    cachedRead(settings, async (context) => {
      const days = parseNetworkHistoryQuery(context.req.url);
      return {
        key: networkHistoryKey(new URL(context.req.url).origin, days),
        body: () =>
          networkHistoryPage(context.get('storage'), days, settings.now()),
      };
    }),
  );
  app.get(
    INDEX_ROUTES.OFFER_HISTORY,
    cachedRead(settings, async (context) => {
      const query = await parseOfferHistoryQuery(context.req.url);
      return {
        key: offerHistoryKey(new URL(context.req.url).origin, query),
        body: () =>
          offerHistoryPage(
            context.get('storage'),
            query,
            settings.now(),
            settings.maxResponseBytes,
          ),
      };
    }),
  );
}

export function createDiscoveryIndex(options: DiscoveryIndexOptions = {}) {
  const settings = settingsOf(options);
  const app = new Hono<IndexEnv>();
  app.use('*', admitRequest(settings));
  // Storage failures map to one static code; details are neither returned nor logged.
  app.onError((_error, context) =>
    rejection(context, INDEX_ERRORS.UNAVAILABLE),
  );
  app.notFound((context) => rejection(context, INDEX_ERRORS.NOT_FOUND));
  const { publishers, registrations, registry } = settings;
  // Closed publishing answers 503 before the body is read or any publish limit is consumed.
  if (!publishers && !registrations)
    app.post(INDEX_ROUTES.RECORDS, (context) =>
      rejection(context, INDEX_ERRORS.UNAVAILABLE),
    );
  else
    app.post(
      INDEX_ROUTES.RECORDS,
      bodyLimit({
        maxSize: DISCOVERY_INDEX_LIMITS.maxBodyBytes,
        onError: (context) =>
          rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE),
      }),
      publishHandler(settings),
    );
  if (!registrations || !registry)
    app.post(INDEX_ROUTES.REGISTRATIONS, (context) =>
      rejection(context, INDEX_ERRORS.UNAVAILABLE),
    );
  else
    app.post(
      INDEX_ROUTES.REGISTRATIONS,
      async (context, next) => {
        context.set('country', requestCountry(context));
        await next();
      },
      bodyLimit({
        maxSize: REGISTRATION.maxBodyBytes,
        onError: (context) =>
          rejection(context, INDEX_ERRORS.PAYLOAD_TOO_LARGE),
      }),
      registrationHandler(settings, registrations, registry),
    );
  readRoutes(app, settings);
  historyRoutes(app, settings);
  githubClaimRoutes(app, settings);
  profileRoutes(app, settings);
  // Reports the publish mode only, never the allowlisted or registered NodeIds.
  app.get(INDEX_ROUTES.HEALTH, async (context) => {
    const records = await settings.records.read(
      context.get('storage'),
      settings.now(),
      () => readAllowed(context),
    );
    if (records === null) return rejection(context, INDEX_ERRORS.RATE_LIMITED);
    return context.json({
      ok: true,
      records,
      publish: publishModeOf(publishers, !!registrations),
    });
  });
  return app;
}

export type DiscoveryIndex = ReturnType<typeof createDiscoveryIndex>;
