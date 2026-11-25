import type { ReactNode } from 'react';

import { Button, type ButtonProps } from './UI';

export function ActionButton({
  icon,
  label,
  className = '',
  ...props
}: Omit<ButtonProps, 'children' | 'title'> & {
  icon: ReactNode;
  label: string;
}) {
  return (
    <Button
      {...props}
      title={label}
      className={`ui-action-button ${className}`}
    >
      {icon}
      <span className="ui-action-label">{label}</span>
    </Button>
  );
}
