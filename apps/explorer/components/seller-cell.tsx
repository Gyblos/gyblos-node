import { BadgeCheck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { gistUrl } from '../lib/config';
import { SELLER_NAME } from '../lib/constants';
import { short } from '../lib/format';
import type { GithubAccount } from '../lib/network-status';
import { sellerHref, sellerNameHint } from '../lib/seller-identity';
import { Identicon } from './identicon';

export function SellerCell({
  nodeId,
  github,
  name = null,
  children,
  href = sellerHref(nodeId),
}: {
  nodeId: string;
  github: GithubAccount | null;
  name?: string | null;
  children?: ReactNode;
  href?: string | null;
}) {
  const label = github ? `@${github.account}` : short(nodeId);
  return (
    <div className="seller-cell flex items-center gap-3">
      {href ? (
        <Link href={href} aria-hidden="true" tabIndex={-1} className="shrink-0">
          <Identicon nodeId={nodeId} />
        </Link>
      ) : (
        <Identicon nodeId={nodeId} />
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-1 font-mono">
          {href ? (
            <Link
              className="text-ink underline-offset-2 hover:underline"
              href={href}
            >
              {label}
            </Link>
          ) : (
            <span className="text-ink">{label}</span>
          )}
          {github ? (
            <a
              className="inline-flex hover:text-ink hover:underline underline-offset-2"
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
        {name ? (
          <div
            className="max-w-56 truncate font-sans text-xs text-dim"
            title={sellerNameHint(name)}
          >
            <bdi>{name}</bdi>
            <span className="sr-only">, {SELLER_NAME.hint}</span>
          </div>
        ) : null}
        {children ? <div className="text-xs text-dim">{children}</div> : null}
      </div>
    </div>
  );
}
