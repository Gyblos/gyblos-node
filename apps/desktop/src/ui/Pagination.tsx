// Shared bounded pagination for locally stored session and payment histories.
import { ArrowLeft, ArrowRight } from '@phosphor-icons/react';
import { Fragment } from 'react';

import { BUTTON_VARIANT } from './constants';
import { HISTORY } from './history-constants';
import { ChoiceMenu } from './Management';
import { Button } from './UI';

function pageNumbers(current: number, total: number) {
  if (total <= HISTORY.PAGE_BUTTONS)
    return Array.from({ length: total }, (_, index) => index + 1);
  return [...new Set([1, current - 1, current, current + 1, total])]
    .filter((page) => page >= 1 && page <= total)
    .sort((left, right) => left - right);
}
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  label = 'Session pagination',
}: {
  label?: string;
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const numbers = pageNumbers(page, pages);
  return (
    <nav className="ui-pagination" aria-label={label}>
      <span className="ui-pagination-summary" aria-live="polite">
        {total ? (page - 1) * pageSize + 1 : 0}–
        {Math.min(page * pageSize, total)} of {total}
      </span>
      <ChoiceMenu
        label="Rows per page"
        value={pageSize + ' / page'}
        options={HISTORY.PAGE_SIZES.map((size) => size + ' / page')}
        onChange={(value) => {
          const next = Number.parseInt(value, 10);
          if (HISTORY.PAGE_SIZES.some((size) => size === next))
            onPageSize(next);
        }}
      />
      <div className="ui-pagination-controls">
        <Button
          className="ui-icon-button"
          aria-label="Previous page"
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <div className="ui-pagination-pages">
          {numbers.map((number, index) => (
            <Fragment key={number}>
              {index > 0 && number - numbers[index - 1]! > 1 && (
                <span aria-hidden="true">…</span>
              )}
              <Button
                variant={
                  page === number
                    ? BUTTON_VARIANT.SECONDARY
                    : BUTTON_VARIANT.GHOST
                }
                aria-current={page === number ? 'page' : undefined}
                aria-label={'Page ' + number}
                onClick={() => onPage(number)}
              >
                {number}
              </Button>
            </Fragment>
          ))}
        </div>
        <span className="ui-pagination-compact">
          Page {page} of {pages}
        </span>
        <Button
          className="ui-icon-button"
          aria-label="Next page"
          disabled={page === pages}
          onClick={() => onPage(page + 1)}
        >
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
