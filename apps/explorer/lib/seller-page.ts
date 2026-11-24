import { PAGES } from './constants';
import { modelFromSlug } from './offers';

const NODE_ID = /^[0-9a-f]{64}$/;

export const sellerNodeId = (value: string) =>
  NODE_ID.test(value) ? value : null;

export function pagePath(pathname: string) {
  const modelPrefix = `${PAGES.models}/`;
  if (
    pathname.startsWith(modelPrefix) &&
    modelFromSlug(pathname.slice(modelPrefix.length))
  )
    return pathname;
  const prefix = `${PAGES.sellers}/`;
  const nodeId = pathname.startsWith(prefix)
    ? sellerNodeId(pathname.slice(prefix.length))
    : null;
  const page = Object.values(PAGES).find((path) => path === pathname);
  return nodeId ? pathname : (page ?? PAGES.network);
}
