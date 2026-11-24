'use client';

import { ArrowUpRight, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { SITE_LINKS } from '../lib/config';
import { PAGE_LINKS, PAGES } from '../lib/constants';
import { cx } from './board/cx';

const ITEM = 'block rounded-lg px-3 py-1.5 hover:bg-raised hover:text-ink';

const isCurrent = (pathname: string, href: string) =>
  href === PAGES.network
    ? pathname === href
    : pathname === href ||
      (href === PAGES.sellers && pathname.startsWith(`${PAGES.sellers}/`));

function Items({
  pathname,
  onPick,
  stacked,
}: {
  pathname: string;
  onPick?: () => void;
  stacked: boolean;
}) {
  return (
    <ul
      className={cx(
        'text-sm whitespace-nowrap',
        stacked ? 'flex flex-col gap-0.5' : '-mx-3 flex gap-1',
      )}
    >
      {PAGE_LINKS.map((link) => {
        const current = isCurrent(pathname, link.href);
        return (
          <li key={link.href}>
            <Link
              href={link.href}
              onClick={onPick}
              aria-current={
                pathname === link.href ? 'page' : current ? 'true' : undefined
              }
              className={cx(
                ITEM,
                stacked && 'py-2',
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
          target="_blank"
          rel="noopener noreferrer"
          onClick={onPick}
          className={cx(
            ITEM,
            stacked && 'py-2',
            'inline-flex items-center gap-1 text-muted',
          )}
        >
          Docs
          <ArrowUpRight aria-hidden className="size-3" />
        </a>
      </li>
    </ul>
  );
}

export function NavLinks() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const here =
    PAGE_LINKS.find((link) => isCurrent(pathname, link.href))?.label ??
    PAGE_LINKS[0].label;
  return (
    <>
      <div className="hidden sm:block">
        <Items pathname={pathname} stacked={false} />
      </div>
      <div className="sm:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="explorer-menu"
          onClick={() => setOpen((isOpen) => !isOpen)}
          className="flex w-full items-center justify-between rounded-lg bg-raised px-3 py-2 text-sm text-ink"
        >
          {here}
          <ChevronDown
            aria-hidden
            className={cx(
              'size-4 text-muted transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
        {open ? (
          <div id="explorer-menu" className="mt-2">
            <Items pathname={pathname} stacked onPick={() => setOpen(false)} />
          </div>
        ) : null}
      </div>
    </>
  );
}
