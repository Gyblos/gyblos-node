import { BadgeCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import type { GithubAccount } from '../lib/network-status';
import { gistUrl } from '../lib/seller-identity';
import { Identicon } from './identicon';

export function SellerCell({
  nodeId,
  github,
  children,
}: {
  nodeId: string;
  github: GithubAccount | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Identicon nodeId={nodeId} />
      <div className="min-w-0">
        {github ? (
          <a
            className="flex items-center gap-1 font-sans text-ink hover:text-brand"
            href={gistUrl(github)}
            title="GitHub account verified by the discovery index: open the proof gist"
          >
            <span>@{github.account}</span>
            <BadgeCheck
              aria-label="Verified GitHub account"
              className="size-3.5 shrink-0 text-brand"
            />
          </a>
        ) : null}
        <div className={github ? 'text-xs text-dim' : undefined}>
          {children}
        </div>
      </div>
    </div>
  );
}
