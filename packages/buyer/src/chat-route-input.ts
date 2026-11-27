// Parse the authenticated chat request before asking any seller for a quote.
import { isOpeningIntent } from '@gyblos/node/desktop-opening';
import { BUYER_API, parseBuyerSellerChoice } from '@gyblos/protocol/buyer-api';
import type { ModelSelection } from '@gyblos/protocol/control-types';

import type { ChatApi } from './chat-api';
import { withoutStop } from './chat-stop';
import { FREE_BUYER_CODES, OPENROUTER } from './constants';
import { FreeBuyerError } from './free-chat';
import type { RouteContext } from './free-context';
import {
  endpointRoutes,
  requestedModel,
  type ModelRoute,
} from './model-routes';

export interface ChatSettings {
  selection: ModelSelection;
  maxTokens: number;
  sellerChoice?: boolean;
  parallel?: number;
  paidAuto?: true;
  tools?: boolean; // true only where every request runs on the free channel
  // The models served by name; absent, `selection` is the one model.
  models?: readonly ModelRoute[];
  // The context every eligible seller of a route accepts, from verified catalogs; undefined if unknown.
  contextTokens?: RouteContext<ModelRoute>;
}
function parseDesktopMode(
  body: unknown,
  settings: ChatSettings,
  selectedSellerAllowed: boolean,
) {
  let auto = false;
  let openingIntent: string | undefined;
  if (body && typeof body === 'object' && BUYER_API.AUTO_FIELD in body) {
    const fields: Record<string, unknown> = Object.fromEntries(
      Object.entries(body),
    );
    const {
      [BUYER_API.AUTO_FIELD]: mode,
      [BUYER_API.OPENING_INTENT_FIELD]: intent,
      ...rest
    } = fields;
    if (
      !selectedSellerAllowed ||
      !settings.paidAuto ||
      mode !== true ||
      BUYER_API.FREE_ONLY_FIELD in rest ||
      BUYER_API.SELLER_CHOICE_FIELD in rest ||
      (intent !== undefined && !isOpeningIntent(intent))
    )
      throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
    if (typeof intent === 'string') openingIntent = intent;
    auto = true;
    body = rest;
  }
  let freeOnly = false;
  if (body && typeof body === 'object' && BUYER_API.FREE_ONLY_FIELD in body) {
    freeOnly = true;
    if (
      !selectedSellerAllowed ||
      body[BUYER_API.FREE_ONLY_FIELD] !== true ||
      BUYER_API.SELLER_CHOICE_FIELD in body
    )
      throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
    const { [BUYER_API.FREE_ONLY_FIELD]: _free, ...rest } = body;
    body = rest;
  }
  return { body, auto, freeOnly, openingIntent };
}
// The model a request names (or the first of its OpenRouter fallbacks that this endpoint serves), and its
// input parsed against that model's route. The answer echoes the name that matched. The fallback list and
// the buyer's own stop sequences are not part of what a seller receives.
export function routedInput(
  api: ChatApi,
  body: unknown,
  settings: ChatSettings,
  streaming: boolean,
  selectedSellerAllowed: boolean,
) {
  const mode = parseDesktopMode(body, settings, selectedSellerAllowed);
  body = mode.body;
  const { auto, freeOnly, openingIntent } = mode;
  if (
    body &&
    typeof body === 'object' &&
    BUYER_API.SELLER_CHOICE_FIELD in body
  ) {
    if (!selectedSellerAllowed)
      throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
    const { [BUYER_API.SELLER_CHOICE_FIELD]: value, ...choiceBody } = body;
    const fields: Record<string, unknown> = choiceBody;
    const { [BUYER_API.OPENING_INTENT_FIELD]: intent, ...rest } = fields;
    if (intent !== undefined && !isOpeningIntent(intent))
      throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
    const sellerChoice = parseBuyerSellerChoice(value, Date.now());
    const { modelId, variant, quantization } = sellerChoice;
    const selection = { modelId, variant, quantization };
    const route = {
      selection,
      maxTokens: Math.min(settings.maxTokens, sellerChoice.contextTokens),
      sellerChoice,
      ...(intent && { openingIntent: intent }),
    };
    const input = api.parse(rest, selection, route.maxTokens, streaming, false);
    const { stream: _stream, ...payload } = input;
    return { input, payload: withoutStop(payload), route, model: modelId };
  }
  if (selectedSellerAllowed && !freeOnly && !auto)
    throw new FreeBuyerError(FREE_BUYER_CODES.INVALID);
  const { route, name } = requestedModel(
    endpointRoutes(settings),
    body,
    !!settings.models?.length,
  );
  const model = name ?? route.id;
  let request = body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { [OPENROUTER.fallbackField]: _fallbacks, ...rest } = body as Record<
      string,
      unknown
    >;
    request = name === undefined ? rest : { ...rest, model: name };
  }
  const input = api.parse(
    request,
    { ...route.selection, modelId: model },
    route.maxTokens,
    streaming,
    settings.tools ?? false,
  );
  const { stream: _stream, ...rest } = input; // all but the stream flag
  return {
    input,
    payload: withoutStop(rest),
    route: {
      ...route,
      ...(freeOnly && { freeOnly: true }),
      ...(openingIntent && { openingIntent }),
    },
    model,
  };
}
