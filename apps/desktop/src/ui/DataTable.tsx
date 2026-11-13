// Shared responsive data table: columns on wide pages, labeled cells on compact pages.
import type { ReactNode } from 'react';

export function DataTable({
  caption,
  headings,
  children,
}: {
  caption: string;
  headings: readonly string[];
  children: ReactNode;
}) {
  return (
    <div className="ui-data-table-wrap">
      <table className="ui-data-table" role="table">
        <caption className="sr-only">{caption}</caption>
        <thead role="rowgroup">
          <tr role="row">
            {headings.map((heading) => (
              <th key={heading} scope="col" role="columnheader">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">{children}</tbody>
      </table>
    </div>
  );
}
export function DataCell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <td role="cell">
      <span className="ui-table-cell-label" aria-hidden="true">
        {label}
      </span>
      {children}
    </td>
  );
}
