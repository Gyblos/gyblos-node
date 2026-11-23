import { SELLER_PAGE } from './constants';

const NODE_ID = /^[0-9a-f]{64}$/;

export const sellerNodeId = (value: string) =>
  NODE_ID.test(value) ? value : null;

export function pagePath(pathname: string) {
  const prefix = `${SELLER_PAGE.path}/`;
  const nodeId = pathname.startsWith(prefix)
    ? sellerNodeId(pathname.slice(prefix.length))
    : null;
  return nodeId ? pathname : '/';
}
