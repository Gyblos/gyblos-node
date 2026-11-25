import type { ReactNode } from 'react';

export interface Column {
  label: string;
  right?: boolean;
  group?: string;
  compactGroup?: string;
  sort?: string;
  ascendingFirst?: boolean;
  prefix?: keyof typeof prefixInset;
}

const prefixInset = {
  seller: 'ps-9',
  model: 'ps-7',
  online: 'ps-6',
  chip: 'ps-1.5',
  operation: 'ps-6',
} as const;

export function prefixedColumn(
  label: string,
  prefix: keyof typeof prefixInset,
): Column {
  return { label, prefix };
}

export function EmptyRow({
  columns,
  children,
}: {
  columns: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td className="explorer-table-empty" colSpan={columns}>
        <span>{children}</span>
      </td>
    </tr>
  );
}

export function HeaderText({ column }: { column: Column }) {
  return column.prefix ? (
    <span className={prefixInset[column.prefix]}>{column.label}</span>
  ) : (
    <>{column.label}</>
  );
}
