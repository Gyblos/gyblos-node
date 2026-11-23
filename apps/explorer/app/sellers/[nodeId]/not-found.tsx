import Link from 'next/link';

import { PAGING } from '../../../lib/constants';

export default function SellerNotFound() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
      <h1 className="text-xl font-medium">Seller not found</h1>
      <p className="mt-3 text-sm text-muted">
        No seller with this NodeId in the index or in the collector&apos;s data.
      </p>
      <Link
        href={`/#${PAGING.anchors.sellers}`}
        className="mt-4 inline-block text-sm hover:text-brand"
      >
        See the sellers in the explorer
      </Link>
    </div>
  );
}
