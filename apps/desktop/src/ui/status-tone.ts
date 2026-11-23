export const TONE = {
  SUCCESS: 'success',
  WARNING: 'warning',
  DANGER: 'danger',
  INFO: 'info',
  NEUTRAL: 'neutral',
} as const;
export type Tone = (typeof TONE)[keyof typeof TONE];

export function statusTone(status: string): Tone {
  if (/void|cancel|revoked|free/i.test(status)) return TONE.NEUTRAL;
  if (/fail|declin|error/i.test(status)) return TONE.DANGER;
  if (/review|unknown|unconfirmed|needed/i.test(status)) return TONE.WARNING;
  if (/captured|confirmed|active|verified|paid/i.test(status))
    return TONE.SUCCESS;
  if (/open|pending|awaiting|authoriz/i.test(status)) return TONE.INFO;
  return TONE.NEUTRAL;
}
