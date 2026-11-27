// Composes durable session admission for authenticated buyers on a priced seller.
import { type HomeEnvironment } from '@gyblos/config/home';
import { batchSellerPathsIn } from '@gyblos/config/home-payments';
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
