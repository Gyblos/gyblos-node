import {
  DISCOVERY_ERROR_CODES,
  type DiscoveryErrorCode,
} from '@gyblos/discovery-http';
import {
  PROFILE_CLAIM,
  SELLER_NAME_ISSUES,
  type SellerNameIssue,
} from '@gyblos/protocol/profile-claim';

import { SELLER_NAME } from './constants';
import { RETRY_LATER } from './verify-github-index';

const AGAIN = 'run the same command again';
const RESERVED = PROFILE_CLAIM.reservedWords.map((word) => `"${word}"`);

export const UNVERIFIED =
  'Names are chosen by each seller: they are not verified and not unique. Only `gyblos seller verify github` verifies who runs a seller';
export const SHOW_DELAY = `The index may take up to ${SELLER_NAME.showDelaySeconds} seconds to show it`;
export const HIDE_DELAY = `The index may take up to ${SELLER_NAME.showDelaySeconds} seconds to stop showing it`;
export const QUOTE_HINT =
  ". Use a straight apostrophe ' instead of other quote marks";
export const HELD_STATUS =
  'An index operator removed the public name of this seller, and a new one cannot be set until the operator allows it';
export const TERMINAL_HINT =
  '. If you typed letters that show here as ?, your terminal did not send them as UTF-8: on Windows, use Windows Terminal or PowerShell 7';

export const ISSUE_TEXT: Readonly<Record<SellerNameIssue, string>> = {
  [SELLER_NAME_ISSUES.LENGTH]: `A seller name has ${PROFILE_CLAIM.minNameCharacters} to ${PROFILE_CLAIM.maxNameCharacters} characters`,
  [SELLER_NAME_ISSUES.CHARACTERS]:
    "A seller name may use only letters, numbers, spaces and - _ . ', with at least one letter or number. Emoji, symbols such as check marks, small capital or modifier letters and invisible characters are not allowed",
  [SELLER_NAME_ISSUES.MARKS]: `Accents and other marks must follow a letter, with at most ${PROFILE_CLAIM.maxMarksInRow} in a row, and marks that enclose or strike through letters are not allowed`,
  [SELLER_NAME_ISSUES.SCRIPTS]:
    'A seller name must use letters from one writing system, such as Latin, Cyrillic, Arabic or Devanagari. Chinese characters may be mixed with Japanese kana, Korean Hangul or Bopomofo',
  [SELLER_NAME_ISSUES.RESERVED]: `A seller name may not contain ${RESERVED.slice(0, -1).join(', ')} or ${RESERVED.at(-1)}, even with other letter cases, digits for letters, spaces or punctuation`,
};

const INDEX_HINTS: ReadonlyMap<DiscoveryErrorCode, string> = new Map<
  DiscoveryErrorCode,
  string
>([
  [
    DISCOVERY_ERROR_CODES.UNKNOWN_NODE,
    `The index does not know this seller yet. Register it with \`gyblos seller register\`, or start it with publishing on, then ${AGAIN}`,
  ],
  [
    DISCOVERY_ERROR_CODES.RATE_LIMITED,
    `The index got too many attempts. Wait a minute and ${AGAIN}`,
  ],
  [
    DISCOVERY_ERROR_CODES.UNAVAILABLE,
    `The index does not take seller names right now. Try again later`,
  ],
  [
    DISCOVERY_ERROR_CODES.STALE_CLAIM,
    `The index refused the time on this name: this computer's clock may be behind, or a newer name was already sent. Turn on automatic time, then ${AGAIN}`,
  ],
  [
    DISCOVERY_ERROR_CODES.CLAIM_REJECTED,
    `The index refused the name. Update gyblos, then ${AGAIN}`,
  ],
  [
    DISCOVERY_ERROR_CODES.PROFILE_HELD,
    "An index operator removed this seller's name, and a new one cannot be set until the operator allows it. Ask in the Gyblos Telegram (https://t.me/gyblos) why",
  ],
  [
    DISCOVERY_ERROR_CODES.INVALID_SIGNATURE,
    'The index refused the signature. Run `gyblos doctor`',
  ],
  [
    DISCOVERY_ERROR_CODES.HTTP_STATUS,
    'This index does not take seller names yet. Check discovery.url in config.toml',
  ],
  [
    DISCOVERY_ERROR_CODES.MALFORMED_RESPONSE,
    'The index sent an answer this version cannot read. Update gyblos, or try again later',
  ],
]);

function duration(seconds: number) {
  const { secondsShownUpTo, minutesShownUpTo, secondsPerMinute } = SELLER_NAME;
  if (seconds <= secondsShownUpTo) return `${seconds} s`;
  const minutes = Math.round(seconds / secondsPerMinute);
  if (minutes <= minutesShownUpTo) return `${minutes} min`;
  return `${Math.round(minutes / secondsPerMinute)} h`;
}

function clockNote(gapSeconds: number | null) {
  if (
    gapSeconds === null ||
    Math.abs(gapSeconds) < SELLER_NAME.clockNoteSeconds
  )
    return '';
  return ` (this computer's clock is ${duration(Math.abs(gapSeconds))} ${gapSeconds > 0 ? 'ahead of' : 'behind'} the index)`;
}

export function indexHint(code: DiscoveryErrorCode, gapSeconds: number | null) {
  const ahead =
    gapSeconds !== null && gapSeconds >= SELLER_NAME.aheadNoteSeconds;
  if (code === DISCOVERY_ERROR_CODES.CLAIM_REJECTED && ahead)
    return `The index refused the signed time on this name: this computer's clock is ${duration(gapSeconds)} ahead of the index. Turn on automatic time, then ${AGAIN}`;
  const hint = INDEX_HINTS.get(code) ?? RETRY_LATER;
  if (code !== DISCOVERY_ERROR_CODES.STALE_CLAIM) return hint;
  const note = clockNote(gapSeconds);
  return hint
    .replace('may be behind', note && ahead ? 'may be wrong' : 'may be behind')
    .replace('. Turn on', `${note}. Turn on`);
}

export function clockGapSeconds(date: string | null, now: number) {
  const server = date === null ? Number.NaN : Date.parse(date);
  return Number.isFinite(server)
    ? Math.round((now - server) / SELLER_NAME.msPerSecond)
    : null;
}
