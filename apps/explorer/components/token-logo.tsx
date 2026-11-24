import { TOKEN_LOGOS, type Token } from '../lib/config';
import { cx } from './board/cx';

export const isToken = (name: string): name is Token => name in TOKEN_LOGOS;

export function TokenLogo({
  token,
  className,
}: {
  token: Token;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        'inline-block size-4 shrink-0 bg-contain bg-center bg-no-repeat',
        className,
      )}
      style={{ backgroundImage: `url(${TOKEN_LOGOS[token]})` }}
    />
  );
}

export const UsdcIcon = ({ className }: { className?: string }) => (
  <TokenLogo token="USDC" className={className} />
);
