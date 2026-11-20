// Composes durable session admission for authenticated buyers on a priced seller.
import { batchSellerPathsIn, type HomeEnvironment } from '@gyblos/config/home';
import { openBatchSellerRegistry } from '@gyblos/payments-upto/batch-session';

export async function sellerChainSessions(
  options: Omit<Parameters<typeof openBatchSellerRegistry>[0], 'paths'> & {
    environment: HomeEnvironment;
  },
) {
  const { environment, ...financial } = options;
  const registry = await openBatchSellerRegistry({
    ...financial,
    paths: batchSellerPathsIn(environment),
  });
  return { registry };
}
