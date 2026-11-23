import { BadgeCheck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { gistUrl } from '../lib/config';
import { short } from '../lib/format';
import type { GithubAccount } from '../lib/network-status';
import { sellerHref } from '../lib/seller-identity';
import { Identicon } from './identicon';

export function SellerCell({
  nodeId,
  github,
  children,
}: {
  nodeId: string;
  github: GithubAccount | null;
  children?: ReactNode;
}) {
  const href = sellerHref(nodeId);
  return (
    <div className="flex items-center gap-2">
      <Link href={href} aria-hidden="true" tabIndex={-1} className="shrink-0">
        <Identicon nodeId={nodeId} />
      </Link>
      <div className="min-w-0">
        <div className="flex items-center gap-1 font-mono">
          <Link className="text-ink hover:text-brand" href={href}>
            {github ? `@${github.account}` : short(nodeId)}
          </Link>
          {github ? (
            <a
              className="inline-flex hover:text-brand"
              href={gistUrl(github)}
              title="GitHub account verified by the discovery index: open the proof gist"
            >
              <BadgeCheck
                role="img"
                aria-label="Verified GitHub account: open the proof gist"
                className="size-3.5 shrink-0 text-signal"
              />
            </a>
          ) : null}
        </div>
        {children ? <div className="text-xs text-dim">{children}</div> : null}
      </div>
    </div>
  );
}
