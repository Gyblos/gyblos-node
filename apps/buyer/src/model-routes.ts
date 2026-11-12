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

import { BUYER_MODELS, FREE_BUYER_CODES, FREE_CHAT_DETAILS } from './constants';
import { FreeBuyerError } from './free-chat-error';

export interface ModelRoute {
  // The name clients send as `model`, and the ones it also answers to.
  id: string;
  aliases: string[];
  selection: ModelSelection;
  // The longest answer this buyer asks a seller for on this model.
  maxTokens: number;
}

// What a request needs to find and quote a seller for one model.
export type RoutedModel = Pick<ModelRoute, 'selection' | 'maxTokens'>;

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

export const singleModelRoute = (request: SellerRequest): ModelRoute[] => [
  {
    id: request.selection.modelId,
    aliases: [],
    selection: request.selection,
    maxTokens: request.maxTokens,
  },
];

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
    ? { ...request, selection: model.selection, maxTokens: model.maxTokens }
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

// The route a request body names in `model`, or a 404 refusal that lists the names served.
export function requestedRoute(
  routes: readonly ModelRoute[],
  body: unknown,
): { route: ModelRoute; name: string } {
  const name =
    body && typeof body === 'object' ? Reflect.get(body, 'model') : undefined;
  const route = findModelRoute(routes, name);
  if (!route || typeof name !== 'string')
    throw new FreeBuyerError(
      FREE_BUYER_CODES.MODEL,
      'model',
      FREE_CHAT_DETAILS.unknownModel(
        routes.slice(0, BUYER_MODELS.listedInErrors).map((item) => item.id),
      ),
    );
  return { route, name };
}
