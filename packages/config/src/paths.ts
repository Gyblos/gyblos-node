// HTTP routes shared by node and buyer. Local file locations live in home.ts.
export const ROUTES = {
  health: '/health',
  inference: '/v1/chat/completions',
  agentResponses: '/v1/responses',
  agentMessages: '/v1/messages',
  agentBase: '/v1',
  models: '/v1/models',
  ollamaVersion: '/api/version',
  ollamaTags: '/api/tags',
  ollamaShow: '/api/show',
  ollamaChat: '/api/chat',
  ollamaGenerate: '/api/generate',
  inferenceDefinition: 'POST /v1/chat/completions',
} as const;
