import { RiGithubFill, RiTwitterXFill } from '@remixicon/react';
import Link from 'next/link';

import { SITE_LINKS } from '../lib/config';
import { TokenLogo } from './token-logo';

const LINK = 'hover:text-ink';
const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const;
const TEXT_LINKS = [
  { label: 'Gyblos', href: SITE_LINKS.site },
  { label: 'Docs', href: SITE_LINKS.docs },
  { label: 'Paper', href: SITE_LINKS.paper },
  { label: 'llms.txt', href: '/llms.txt' },
] as const;
const SOCIAL = [
  { label: 'GitHub', href: SITE_LINKS.github, Icon: RiGithubFill },
  { label: 'X', href: SITE_LINKS.x, Icon: RiTwitterXFill },
] as const;

export function SiteFooter() {
  return (
    <footer className="mt-16 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line py-6 text-xs text-dim">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href="/" className="text-body-medium tracking-tight text-ink">
          gyblos
        </Link>
        <span className="inline-flex items-center gap-1.5">
          <TokenLogo token="SOLANA" className="size-3.5" />
          Solana
        </span>
        <span className="inline-flex items-center gap-1.5">
          <TokenLogo token="USDC" className="size-3.5" />
          USDC
        </span>
      </div>
      <nav
        aria-label="Gyblos"
        className="flex flex-wrap items-center gap-x-4 gap-y-2"
      >
        {TEXT_LINKS.map((link) => (
          <a key={link.href} href={link.href} className={LINK} {...NEW_TAB}>
            {link.label}
          </a>
        ))}
        <span aria-hidden className="h-3 w-px bg-line" />
        {SOCIAL.map(({ label, href, Icon }) => (
          <a
            key={href}
            href={href}
            aria-label={label}
            className={LINK}
            {...NEW_TAB}
          >
            <Icon aria-hidden className="size-4" />
          </a>
        ))}
      </nav>
    </footer>
  );
}
