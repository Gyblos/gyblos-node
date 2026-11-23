'use client';

import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { SITE_LINKS } from '../lib/config';
import { PAGE_LINKS, PAGES, SELLER_PAGE } from '../lib/constants';
import { cx } from './board/cx';

const ITEM = 'block rounded-lg px-3 py-1.5 hover:bg-raised hover:text-ink';

const isCurrent = (pathname: string, href: string) =>
  href === PAGES.network
    ? pathname === href
    : pathname === href ||
      (href === PAGES.sellers && pathname.startsWith(`${SELLER_PAGE.path}/`));

export function NavLinks() {
  const pathname = usePathname();
  return (
    <ul className="-mx-3 flex gap-1 overflow-x-auto text-sm whitespace-nowrap">
      {PAGE_LINKS.map((link) => {
        const current = isCurrent(pathname, link.href);
        return (
          <li key={link.href}>
            <Link
              href={link.href}
              aria-current={current ? 'page' : undefined}
              className={cx(
                ITEM,
                current ? 'bg-raised text-ink' : 'text-muted',
              )}
            >
              {link.label}
            </Link>
          </li>
        );
      })}
      <li>
        <a
          href={SITE_LINKS.docs}
          className={cx(ITEM, 'inline-flex items-center gap-1 text-muted')}
        >
          Docs
          <ArrowUpRight aria-hidden className="size-3" />
        </a>
      </li>
    </ul>
  );
}
