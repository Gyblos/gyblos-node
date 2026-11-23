import Link from 'next/link';

const link = 'hover:text-brand';

export function PageLinks({
  page,
  pages,
  href,
}: {
  page: number;
  pages: number;
  href: (page: number) => string;
}) {
  if (pages <= 1) return null;
  return (
    <nav
      aria-label="Pages"
      className="my-3 flex items-center justify-end gap-4 font-mono text-xs text-muted"
    >
      {page > 1 ? (
        <Link className={link} href={href(page - 1)} scroll={false}>
          Previous
        </Link>
      ) : null}
      <span>
        Page {page} of {pages}
      </span>
      {page < pages ? (
        <Link className={link} href={href(page + 1)} scroll={false}>
          Next
        </Link>
      ) : null}
    </nav>
  );
}
