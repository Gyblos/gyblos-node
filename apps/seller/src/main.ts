import { loadConfig, signer } from '../../../scripts/config.js';
import { assertProgram } from '../../../packages/payments-x402/src/chain.js';
import { createGateSeller } from '../../../packages/payments-x402/src/seller.js';

const config = await loadConfig();
await assertProgram(config.rpcUrl);
const { app } = await createGateSeller({ rpcUrl: config.rpcUrl, facilitatorUrl: 'http://127.0.0.1:4022',
  mint: config.mint, payTo: config.addresses.seller, authorizer: await signer(config, 'authorizer'), runId: process.env.GYBLOS_GATE_RUN_ID });
const server = app.listen(4021, '127.0.0.1', () => { console.log('Gate seller ready at http://127.0.0.1:4021 (fixed resource; no inference).'); });
process.once('SIGTERM', () => { server.close(() => process.exit(0)); });
process.once('SIGINT', () => { server.close(() => process.exit(0)); });
