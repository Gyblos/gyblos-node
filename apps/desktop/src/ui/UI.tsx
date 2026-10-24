// Shared compact desktop primitives; visual sizes and variants live in ui.css.
// Components render local UI only and do not own model, payment or agent workflows.
import { MagnifyingGlass, ShieldCheck, X } from '@phosphor-icons/react';
import {
  useRef,
  type ComponentPropsWithoutRef,
  type ComponentPropsWithRef,
  type ReactNode,
} from 'react';

import { BUTTON_VARIANT } from './constants.js';
import { useTooltip } from './Tooltip.js';

type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: (typeof BUTTON_VARIANT)[keyof typeof BUTTON_VARIANT];
};
export function Button({
  variant = BUTTON_VARIANT.GHOST,
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  const {
    title,
    onMouseEnter,
    onMouseLeave,
    onPointerMove,
    onFocus,
    onBlur,
    onClick,
    onKeyDown,
    ...rest
  } = props;
  const tip = useTooltip(title);
  return (
    <>
      <button
        {...rest}
        aria-label={props['aria-label'] ?? title}
        type={type}
        style={{ ...props.style, anchorName: tip.anchor }}
        aria-describedby={
          [props['aria-describedby'], tip.id].filter(Boolean).join(' ') ||
          undefined
        }
        onMouseEnter={(event) => {
          tip.reset();
          onMouseEnter?.(event);
        }}
        onPointerMove={(event) => {
          tip.reset();
          onPointerMove?.(event);
        }}
        onMouseLeave={(event) => {
          tip.reset();
          onMouseLeave?.(event);
        }}
        onFocus={(event) => {
          tip.reset();
          onFocus?.(event);
        }}
        onBlur={(event) => {
          tip.reset();
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') tip.dismiss();
          onKeyDown?.(event);
        }}
        onClick={(event) => {
          tip.dismiss();
          onClick?.(event);
        }}
        className={`ui-button ui-button--${variant} ${className}`}
      />
      {tip.tooltip}
    </>
  );
}
export function IconButton({
  label,
  className = '',
  ...props
}: Omit<ButtonProps, 'aria-label'> & { label: string }) {
  return (
    <Button
      {...props}
      aria-label={label}
      title={props.title ?? label}
      className={`ui-icon-button ${className}`}
    />
  );
}
// Choice semantics and compact row anatomy are shared by model and tool menus.
export function MenuItem({
  label,
  detail,
  badge,
  leading,
  trailing,
  footer = false,
  checked,
  role = 'menuitem',
  ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'role'> & {
  label: string;
  detail?: string;
  badge?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  footer?: boolean;
  checked?: boolean;
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
}) {
  return (
    <button
      {...props}
      type="button"
      role={role}
      aria-checked={role === 'menuitem' ? undefined : checked}
      className={`dropdown-row${footer ? ' dropdown-footer' : ''}`}
    >
      {leading}
      {footer ? (
        <span>{label}</span>
      ) : (
        <span className="dropdown-copy">
          {badge ? (
            <span className="ui-item-title">
              <strong>{label}</strong>
              {badge}
            </span>
          ) : (
            <strong>{label}</strong>
          )}
          {detail && <small>{detail}</small>}
        </span>
      )}
      {trailing}
    </button>
  );
}

export function Badge({
  children,
  warm = false,
}: {
  children: ReactNode;
  warm?: boolean;
}) {
  return (
    <span className={`ui-badge${warm ? ' ui-badge--warm' : ''}`}>
      {children}
    </span>
  );
}
export function Avatar({ children }: { children: ReactNode }) {
  return <span className="ui-avatar">{children}</span>;
}
export function SearchField({
  label,
  value,
  onValueChange,
  className = '',
  compact = false,
  ...props
}: Omit<ComponentPropsWithoutRef<'input'>, 'value' | 'onChange' | 'size'> & {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`ui-search${compact ? ' ui-search--compact' : ''} ${className}`}
    >
      <MagnifyingGlass size={16} aria-hidden="true" />
      <input
        {...props}
        ref={input}
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {value && (
        <IconButton
          label={`Clear ${label.toLowerCase()}`}
          onClick={() => {
            onValueChange('');
            input.current?.focus();
          }}
        >
          <X size={16} />
        </IconButton>
      )}
    </div>
  );
}
export function PagePanel({ children }: { children: ReactNode }) {
  return (
    <main className="ui-page" aria-labelledby="route-title">
      {children}
    </main>
  );
}
export function SectionTitle({
  children,
  trailing,
}: {
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="ui-section-title">
      <h2>{children}</h2>
      {trailing}
    </div>
  );
}
export function List({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="ui-list" role="group" aria-label={label}>
      {children}
    </div>
  );
}
export function ListRow({
  leading,
  children,
  trailing,
  onActivate,
  selected,
}: {
  leading: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  onActivate?: () => void;
  selected?: boolean;
}) {
  const content = (
    <>
      <span className="ui-row-leading">{leading}</span>
      <div className="ui-row-content">{children}</div>
      {trailing && <div className="ui-row-trailing">{trailing}</div>}
    </>
  );
  return onActivate ? (
    <button
      type="button"
      className="ui-row ui-row--action"
      onClick={onActivate}
      aria-pressed={selected}
    >
      {content}
    </button>
  ) : (
    <div className="ui-row">{content}</div>
  );
}
export function RowCopy({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="ui-copy">
      <strong>{title}</strong>
      <small title={detail}>{detail}</small>
    </div>
  );
}
export function InfoBar({
  leading,
  children,
  trailing,
}: {
  leading?: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="ui-info-bar">
      {leading}
      <div>{children}</div>
      {trailing}
    </div>
  );
}
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="ui-note">
      <ShieldCheck size={16} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
export function StatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="ui-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
export function EmptyState({
  icon,
  title,
  description,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="ui-empty">
      {icon}
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}
