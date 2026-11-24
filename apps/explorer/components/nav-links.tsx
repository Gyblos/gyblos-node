'use client';

import { ArrowUpRight, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useRef, useState, type KeyboardEvent } from 'react';

import { SITE_LINKS } from '../lib/config';
import { PAGE_LINKS } from '../lib/constants';
import { currentPage, isCurrentPage } from '../lib/layout';
import { cx } from './board/cx';

const ITEM = 'block rounded-lg px-3 py-1.5 hover:bg-raised hover:text-ink';
const STACKED = 'flex min-h-11 items-center py-2';
const MENU_ID = 'explorer-menu';

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
        stacked ? 'flex flex-col gap-0.5' : '-mx-3 flex flex-wrap gap-1',
      )}
    >
      {PAGE_LINKS.map((link) => {
        const current = isCurrentPage(pathname, link.href);
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
                stacked && STACKED,
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
          className={cx(
            ITEM,
            stacked && STACKED,
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
  const location = `${pathname}?${useSearchParams().toString()}`;
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(location);
  if (seen !== location) {
    setSeen(location);
    setOpen(false);
  }
  const button = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    close();
    button.current?.focus();
  };
  const here = currentPage(pathname);
  return (
    <>
      <div className="hidden sm:block">
        <Items pathname={pathname} stacked={false} />
      </div>
      <div className="sm:hidden" onKeyDown={onKeyDown}>
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          aria-controls={MENU_ID}
          onClick={() => setOpen(!open)}
          className="flex min-h-11 w-full items-center justify-between rounded-lg bg-raised px-3 py-2 text-sm text-ink"
        >
          <span>
            <span className="sr-only">Pages, current: </span>
            {here?.label ?? 'Pages'}
          </span>
          <ChevronDown
            aria-hidden
            className={cx(
              'size-4 text-muted transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
        <div id={MENU_ID} hidden={!open} className="mt-2">
          <Items pathname={pathname} stacked onPick={close} />
        </div>
        <noscript>
          <Items pathname={pathname} stacked />
        </noscript>
      </div>
    </>
  );
}
