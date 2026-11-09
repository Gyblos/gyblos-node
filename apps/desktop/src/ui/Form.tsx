// Shared form primitives for buyer surfaces; the caller owns values and actions.
import { Copy } from '@phosphor-icons/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { BUTTON_VARIANT } from './constants';
import { Button } from './UI';

export function FormField({
  htmlFor,
  label,
  children,
}: {
  htmlFor?: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="ui-field" htmlFor={htmlFor}>
      {label}
      {children}
    </label>
  );
}

export function FormInput({
  className = '',
  ...props
}: ComponentPropsWithoutRef<'input'>) {
  return <input {...props} className={`ui-input ${className}`} />;
}

export function FormActions({
  children,
  align = 'end',
}: {
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <div className={`ui-form-actions ui-form-actions--${align}`}>
      {children}
    </div>
  );
}

export function CopyField({
  id,
  label,
  value,
  secret = false,
  actionLabel,
  disabled,
  onCopy,
}: {
  id: string;
  label: string;
  value: string;
  secret?: boolean;
  actionLabel: string;
  disabled?: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="ui-field">
      <label htmlFor={id}>{label}</label>
      <div className="ui-copy-field">
        <FormInput
          id={id}
          readOnly
          type={secret ? 'password' : 'text'}
          value={value}
        />
        <Button
          variant={BUTTON_VARIANT.GHOST}
          aria-label={actionLabel}
          disabled={disabled}
          onClick={onCopy}
        >
          <Copy size={16} />
          Copy
        </Button>
      </div>
    </div>
  );
}
