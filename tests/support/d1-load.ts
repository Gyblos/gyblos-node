import { collectorLoad } from './d1-load-collector';
import { discoveryLoad } from './d1-load-discovery';
import type { D1LoadRow } from './d1-load-log';

export {
  D1_LOAD_LABELS,
  D1_MAX_BOUND_PARAMETERS,
  type D1LoadLabel,
  type D1LoadRow,
} from './d1-load-log';

export async function measureD1Load(): Promise<D1LoadRow[] | null> {
  const discovery = await discoveryLoad();
  return discovery && [...discovery, ...(await collectorLoad())];
}
