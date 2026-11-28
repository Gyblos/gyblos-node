// The models one buyer endpoint serves: each a public name (with optional aliases) that a client sends as
// `model`, the exact network selection sellers quote for, and its own answer limit. A client switches
// models by naming another one; every request still carries its whole conversation, so nothing is lost.
// Without a `models` list, the request's single selection is the one model, as before.
import { FREE_OUTPUT_TOKENS } from '@gyblos/config';
import type { SellerRequest } from '@gyblos/core/seller-selection';
import { parseModelSelection } from '@gyblos/protocol/control-requests';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import {
  controlArray,
  controlInteger,
  controlObject,
  controlText,
} from '@gyblos/protocol/control-validation';

import {
  BUYER_MODELS,
  FREE_BUYER_CODES,
  FREE_CHAT_DETAILS,
  OPENROUTER,
} from './constants';
import { FreeBuyerError, invalidChat } from './free-chat-error';

export interface ModelRoute {
  // The name clients send as `model`, and the ones it also answers to.
  id: string;
  aliases: string[];
  selection: ModelSelection;
  // The longest answer this buyer asks a seller for on this model.
  maxTokens: number;
}

// What a request needs to find and quote a seller for one model.
export type RoutedModel = Pick<ModelRoute, 'selection' | 'maxTokens'> & {
  sellerWait?(waiting: boolean): void;
  openingIntent?: string;
  freeOnly?: boolean;
  explicitFree?: boolean;
  sellerChoice?: import('@gyblos/protocol/buyer-api').BuyerSellerChoice;
};

function routeName(value: unknown): string {
  const name = controlText(value, BUYER_MODELS.nameCharacters);
  if (!BUYER_MODELS.namePattern.test(name)) throw new Error('model name');
  return name;
}

function parseRoute(value: unknown, request: SellerRequest): ModelRoute {
  const present = (key: string) =>
    !!value && typeof value === 'object' && Object.hasOwn(value, key);
  const row = controlObject(value, [
    'id',
    'selection',
    ...(present('aliases') ? ['aliases'] : []),
    ...(present('maxTokens') ? ['maxTokens'] : []),
  ]);
  return {
    id: routeName(row.id),
    aliases: present('aliases')
      ? controlArray(row.aliases, BUYER_MODELS.maxAliases).map(routeName)
      : [],
    selection: parseModelSelection(row.selection),
    maxTokens:
      row.maxTokens === undefined
        ? request.maxTokens
        : controlInteger(row.maxTokens, 1, FREE_OUTPUT_TOKENS.max),
  };
}

// selection.json `models`: 1 to BUYER_MODELS.maxModels routes, every name unique across ids and aliases.
export function parseModelRoutes(
  value: unknown,
  request: SellerRequest,
): ModelRoute[] {
  const routes = controlArray(value, BUYER_MODELS.maxModels).map((entry) =>
    parseRoute(entry, request),
  );
  const names = routes.flatMap((route) => [route.id, ...route.aliases]);
  if (!routes.length || new Set(names).size !== names.length)
    throw new Error('model routes');
  return routes;
}

export function findModelRoute(
  routes: readonly ModelRoute[],
  name: unknown,
): ModelRoute | undefined {
  if (typeof name !== 'string') return undefined;
  return routes.find(
    (route) => route.id === name || route.aliases.includes(name),
  );
}

// The seller request for one routed model: its selection and answer limit over the shared policy.
export function routedRequest<Request extends SellerRequest>(
  request: Request,
  model: RoutedModel | undefined,
): Request {
  return model
    ? {
        ...request,
        selection: model.selection,
        maxTokens: model.maxTokens,
        ...(model.freeOnly && {
          maxAtomic: '0',
          priceCeilings: { inputAtomicPerMtok: '0', outputAtomicPerMtok: '0' },
        }),
      }
    : request;
}

// The routes an endpoint serves: its configured models, else its single selection.
export function endpointRoutes(settings: {
  selection: ModelSelection;
  maxTokens: number;
  models?: readonly ModelRoute[];
}): readonly ModelRoute[] {
  return settings.models?.length
    ? settings.models
    : [
        {
          id: settings.selection.modelId,
          aliases: [],
          selection: settings.selection,
          maxTokens: settings.maxTokens,
        },
      ];
}

// The spellings a requested name may take for a route: as sent, without an OpenRouter routing suffix
// (:free, :nitro, :floor) and without a provider prefix (qwen/…), so clients written for OpenRouter find
// the same model. Exact names come first, so a route whose own name has a slash or suffix still wins.
function spellings(name: string): string[] {
  const suffix = OPENROUTER.routingSuffixes.find(
    (end) => name.endsWith(end) && name.length > end.length,
  );
  const plain = suffix ? name.slice(0, -suffix.length) : name;
  const slash = plain.indexOf('/');
  return [name, plain, ...(slash > 0 ? [plain.slice(slash + 1)] : [])];
}
function requestedRouteFor(
  routes: readonly ModelRoute[],
  name: unknown,
): ModelRoute | undefined {
  if (typeof name !== 'string') return undefined;
  for (const spelling of spellings(name)) {
    const route = findModelRoute(routes, spelling);
    if (route) return route;
  }
  return undefined;
}

// The names a request asks for, in order: `model`, then OpenRouter's `models` fallback list.
function requestedNames(body: unknown): unknown[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const fallbacks: unknown = Reflect.get(body, OPENROUTER.fallbackField);
  if (fallbacks === undefined || fallbacks === null)
    return [Reflect.get(body, 'model')];
  if (
    !Array.isArray(fallbacks) ||
    fallbacks.length > OPENROUTER.maxFallbacks ||
    fallbacks.some((name) => typeof name !== 'string')
  )
    throw invalidChat(OPENROUTER.fallbackField, FREE_CHAT_DETAILS.models);
  return [Reflect.get(body, 'model'), ...fallbacks];
}

// The route a request names, and the name it used. An unknown name is a 404 listing the names served, but
// only when a model list is configured; anything else (no object, no text name, or the one model's endpoint)
// falls to the first route with no name, so the format's own parser refuses it with the 400 it always gave.
export function requestedModel(
  routes: readonly ModelRoute[],
  body: unknown,
  listed = true,
): { route: ModelRoute; name?: string } {
  const names = requestedNames(body);
  for (const name of names) {
    const route = requestedRouteFor(routes, name);
    if (route) return { route, name: name as string };
  }
  if (!listed || !names.some((name) => typeof name === 'string'))
    return { route: routes[0] as ModelRoute };
  const shown = routes
    .slice(0, BUYER_MODELS.listedInErrors)
    .map((item) => item.id);
  throw new FreeBuyerError(
    FREE_BUYER_CODES.MODEL,
    'model',
    FREE_CHAT_DETAILS.unknownModel(
      routes.length > shown.length ? [...shown, '…'] : shown,
    ),
  );
}
export function requestedRoute(
  routes: readonly ModelRoute[],
  body: unknown,
  listed = true,
): ModelRoute {
  return requestedModel(routes, body, listed).route;
}
