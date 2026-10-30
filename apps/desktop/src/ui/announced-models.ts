// Maps sanitized announcements into shared preview controls; never authorizes inference.
import type { NetworkCatalog } from '../catalog/model';
import type { CatalogModel } from './model-types';
export function announcedModels(_catalog: NetworkCatalog, _now: number): CatalogModel[] { return []; }
