// The buyer owns its local log for the whole host lifetime, including inspect-and-close.
import {
  createLocalDiagnostics,
  loadLocalDiagnostics,
} from '@gyblos/node/diagnostics-startup';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type { DiagnosticSink } from '@gyblos/runtime/diagnostics';

import type { BuyerHost } from './free-startup';

export async function withBuyerDiagnostics(
  start: (sink: DiagnosticSink) => Promise<BuyerHost>,
) {
  const settings = await loadLocalDiagnostics(process.env);
  const diagnostics = createLocalDiagnostics(
    process.env,
    P2P_ROLES.BUYER,
    settings,
  );
  let host: BuyerHost;
  try {
    host = await start(diagnostics.write);
  } catch (error) {
    await diagnostics.close();
    throw error;
  }
  const inspect = host.inspectAndClose;
  return {
    ...host,
    diagnostics: diagnostics.health,
    close: () => host.close().finally(diagnostics.close),
    inspectAndClose: inspect
      ? (...args: Parameters<typeof inspect>) =>
          inspect(...args).finally(diagnostics.close)
      : undefined,
  };
}
