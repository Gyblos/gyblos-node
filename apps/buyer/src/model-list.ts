// GET /v1/models: every route the endpoint serves, with the context its sellers all accept when verified
// catalogs give it in time. A route whose sellers cannot be reached is listed without it.
import type { ServerResponse } from 'node:http';

import type { ModelSelection } from '@gyblos/protocol/control-types';

import { modelList } from './chat-api';
import { replyJson } from './chat-errors';
import { FREE_BUYER } from './constants';
import type { RouteContext } from './free-context';
import { endpointRoutes, type ModelRoute } from './model-routes';

export interface ModelListSettings {
  selection: ModelSelection;
  maxTokens: number;
  models?: readonly ModelRoute[];
  contextTokens?: RouteContext<ModelRoute>;
}
export async function listModels(
  response: ServerResponse,
  settings: ModelListSettings,
) {
  const routes = endpointRoutes(settings);
  const contexts = new Map<string, number>();
  const { contextTokens } = settings;
  if (contextTokens) {
    const signal = AbortSignal.timeout(FREE_BUYER.modelContextMs);
    const found = await Promise.all(
      routes.map((route) =>
        Promise.race([
          contextTokens(route, signal).catch(() => undefined),
          new Promise<undefined>((resolve) =>
            signal.addEventListener('abort', () => resolve(undefined), {
              once: true,
            }),
          ),
        ]),
      ),
    );
    routes.forEach((route, index) => {
      const context = found[index];
      if (context !== undefined) contexts.set(route.id, context);
    });
  }
  if (!response.destroyed) replyJson(response, modelList(routes, contexts));
}
