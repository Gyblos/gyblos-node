import type { CSSProperties } from 'react';

export const BRAND_COLORS = {
  charcoal: '#141414',
  panel: '#1f1f1f',
  raised: '#262626',
  line: '#2a2a2a',
  inkDark: '#f5f5f5',
  mutedDark: '#a3a3a3',
  blue: '#0a28f0',
  onBlue: '#ffffff',
  paper: '#fcfcfc',
  panelLight: '#f4f5f6',
  raisedLight: '#eceef0',
  lineLight: '#dedede',
  inkLight: '#1c1c1c',
  mutedLight: '#5f6368',
  dimLight: '#656565',
  connected: '#68c998',
  connectedLight: '#18794e',
  warm: '#f2c26b',
  warmLight: '#b45309',
  failed: '#ff8b92',
  failedLight: '#b42332',
} as const;

type ThemeStyle = CSSProperties & { [token: `--${string}`]: string };

export function prefersLightTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

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
    '--bubble-user': light
      ? `color-mix(in srgb, ${colors.blue} 12%, ${colors.raisedLight})`
      : `color-mix(in srgb, ${colors.blue} 12%, ${colors.raised})`,
    '--panel': light ? colors.panelLight : colors.panel,
    '--raised': light ? colors.raisedLight : colors.raised,
    '--line': light ? colors.lineLight : colors.line,
    '--subtle-line': light ? colors.lineLight : colors.line,
    '--ink': light ? colors.inkLight : colors.inkDark,
    '--muted': light ? colors.mutedLight : colors.mutedDark,
    '--dim': light ? colors.dimLight : colors.mutedDark,
    '--accent': colors.blue,
    '--accent-hover': 'color-mix(in srgb, var(--accent), black 8%)',
    '--blue': light ? colors.inkLight : colors.inkDark,
    '--soft': 'color-mix(in srgb, var(--accent) 13%, transparent)',
    '--selected-surface': 'var(--soft)',
    '--selected-ink': 'var(--blue)',
    '--focus': light ? colors.inkLight : colors.inkDark,
    '--primary-ink': colors.onBlue,
    '--warm': light ? colors.warmLight : colors.warm,
    '--error': light ? colors.failedLight : colors.failed,
  };
}
