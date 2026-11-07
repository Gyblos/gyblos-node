// Builds an opt-in local request example without embedding the connection credential.
import { ROUTES } from '@gyblos/config/paths';

import type { PaypalAgentResult } from './paypal-agent-model';

function shellLiteral(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function paypalAgentExample(
  connection: Pick<
    NonNullable<PaypalAgentResult['connection']>,
    'url' | 'model'
  >,
) {
  const endpoint = new URL(ROUTES.inference, connection.url).href;
  const body = JSON.stringify({
    model: connection.model,
    messages: [{ role: 'user', content: 'Hello' }],
  });
  return [
    `curl ${shellLiteral(endpoint)} \\`,
    '  --header "Authorization: Bearer $GYBLOS_API_KEY" \\',
    "  --header 'Content-Type: application/json' \\",
    `  --data ${shellLiteral(body)}`,
  ].join('\n');
}
