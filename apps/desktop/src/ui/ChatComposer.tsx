// Shared chat input shell; the caller owns sending, limits and connection state.
import type { ReactNode, Ref } from 'react';

export function ChatComposer({
  ref,
  inputRef,
  disabled = false,
  value,
  placeholder,
  onChange,
  onSubmit,
  children,
}: {
  ref?: Ref<HTMLFormElement>;
  inputRef?: Ref<HTMLTextAreaElement>;
  disabled?: boolean;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form
      ref={ref}
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        ref={inputRef}
        disabled={disabled}
        aria-label="Your message"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            !event.nativeEvent.isComposing &&
            event.key === 'Enter' &&
            !event.shiftKey
          ) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="composer-bottom">{children}</div>
    </form>
  );
}
