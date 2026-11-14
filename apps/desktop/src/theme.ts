// Owns the approved buyer palette, shared by the desktop host and renderer.
// Component styles consume semantic tokens; they do not choose route-specific colors.
import type { CSSProperties } from 'react';

export const BRAND_COLORS = {
  charcoal: '#171717',
  panel: '#1f1f1f',
  raised: '#242424',
  line: '#2e2e2e',
  inkDark: '#ededed',
  mutedDark: '#a1a1a1',
  blue: '#0a28f0',
  onBlue: '#ffffff',
  paper: '#fcfcfc',
  panelLight: '#f4f5f6',
  raisedLight: '#eceef0',
  lineLight: '#e4e6e8',
  inkLight: '#1c1c1c',
  mutedLight: '#5f6368',
  dimLight: '#6b6b6b',
  connected: '#68c998',
  connectedLight: '#18794e',
  warm: '#f2c26b',
  warmLight: '#b45309',
  failed: '#ff8b92',
  failedLight: '#b42332',
} as const;

type ThemeStyle = CSSProperties & { [token: `--${string}`]: string };

export function themeStyle(light: boolean): ThemeStyle {
  const colors = BRAND_COLORS;
  return {
    '--overlay-shadow': light
      ? '0 12px 32px rgba(0, 0, 0, 0.12)'
      : '0 12px 32px rgba(0, 0, 0, 0.35)',
    '--overlay-backdrop': light ? 'rgba(0, 0, 0, 0.25)' : 'rgba(0, 0, 0, 0.6)',
    '--connected': light ? colors.connectedLight : colors.connected,
    '--bg': light ? colors.paper : colors.charcoal,
    '--side': light ? colors.paper : colors.charcoal,
    '--side-elevated': light ? colors.panelLight : colors.panel,
    '--editor': light ? colors.paper : colors.charcoal,
    '--canvas': light ? colors.panelLight : colors.panel,
    '--composer-surface': light ? colors.paper : colors.raised,
    // The user's turn is a distinct material, not the canvas with a text offset.
    '--bubble-user': light
      ? `color-mix(in srgb, ${colors.blue} 12%, ${colors.raisedLight})`
      : `color-mix(in srgb, ${colors.blue} 12%, ${colors.raised})`,
    '--panel': light ? colors.panelLight : colors.panel,
    '--raised': light ? colors.raisedLight : colors.raised,
    '--line': light ? colors.lineLight : colors.line,
    '--subtle-line': light ? colors.lineLight : colors.line,
    '--ink': light ? colors.inkLight : colors.inkDark,
    '--muted': light ? colors.mutedLight : colors.mutedDark,
    // Small desktop labels also sit on raised/selected surfaces: use the landing's
    // stronger secondary gray instead of its dim gray on those surfaces.
    '--dim': light ? colors.dimLight : colors.mutedDark,
    '--accent': colors.blue,
    '--accent-hover': 'color-mix(in srgb, var(--accent), black 8%)',
    '--blue': light
      ? colors.blue
      : 'color-mix(in srgb, var(--accent), white 35%)',
    '--soft': 'color-mix(in srgb, var(--accent) 13%, transparent)',
    '--selected-surface': 'var(--soft)',
    '--selected-ink': 'var(--blue)',
    '--focus': light
      ? colors.blue
      : 'color-mix(in srgb, var(--accent), white 12%)',
    '--primary-ink': colors.onBlue,
    '--warm': light ? colors.warmLight : colors.warm,
    '--error': light ? colors.failedLight : colors.failed,
  };
}
