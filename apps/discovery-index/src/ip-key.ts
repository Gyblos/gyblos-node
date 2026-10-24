// Owns the rate-limit key for a client address: IPv4 by full address, IPv6 by its /64 prefix.
// Keys go only to rate limiters; they are never stored or logged.
import { IPV6, LOCAL_CLIENT_KEY } from './constants.js';

const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;
const EMBEDDED_IPV4 = /\.\d+$/;
const IPV4_TAIL = /[0-9.]+$/;
const HEXTET = /^[0-9a-f]{1,4}$/;
const ZONE = /%.*$/;

// Expands an IPv6 text into its eight hextets, or null when it is not one.
function hextets(ip: string): string[] | null {
  // An embedded IPv4 tail occupies the last two hextets.
  const tail = EMBEDDED_IPV4.test(ip) ? ip.replace(IPV4_TAIL, '0:0') : ip;
  const halves = tail.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill =
    halves.length === 2
      ? Math.max(IPV6.groups - head.length - rest.length, 0)
      : 0;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  if (
    groups.length !== IPV6.groups ||
    !groups.every((group) => HEXTET.test(group))
  )
    return null;
  return groups;
}

// One subscriber allocation is a /64, so rotating addresses within it shares one allowance.
// Unparseable values are used as given.
export function ipKey(value: string | undefined): string {
  if (!value) return LOCAL_CLIENT_KEY;
  const ip = value.trim().toLowerCase().replace(ZONE, '');
  if (!ip.includes(':')) return ip;
  const mapped = MAPPED_IPV4.exec(ip);
  if (mapped?.[1]) return mapped[1];
  const groups = hextets(ip);
  if (!groups) return value;
  const prefix = groups
    .slice(0, IPV6.prefixGroups)
    .map((group) =>
      Number.parseInt(group, IPV6.hexRadix).toString(IPV6.hexRadix),
    );
  return `${prefix.join(':')}::/64`;
}
