// Shared form primitives for buyer surfaces; the caller owns values and actions.
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

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
