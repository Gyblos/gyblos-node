// Uses the landing's canonical colors, organized for compact desktop surfaces.
// Reference: gyblos/web/src/index.css and gyblos-brain/50 Brand/gyblos-brand-tokens.json.
import type { CSSProperties } from 'react';

export const BRAND_COLORS = {
  charcoal: '#171717',
  panel: '#1f1f1f',
  raised: '#242424',
  line: '#2e2e2e',
  inkDark: '#ededed',
  mutedDark: '#a1a1a1',
  sky: '#6cc6ec',
  skyText: '#7dcef0',
  skyInk: '#0b1a22',
  paper: '#fcfcfc',
  panelLight: '#f4f5f6',
  raisedLight: '#eceef0',
  lineLight: '#e4e6e8',
  inkLight: '#1c1c1c',
  mutedLight: '#5f6368',
  dimLight: '#6b6b6b',
  skyTextLight: '#0369a1',
  connected: '#68c998',
  connectedLight: '#18794e',
  warm: '#f2c26b',
  warmLight: '#b45309',
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
      ? `color-mix(in srgb, ${colors.skyTextLight} 12%, ${colors.raisedLight})`
      : `color-mix(in srgb, ${colors.sky} 12%, ${colors.raised})`,
    '--panel': light ? colors.panelLight : colors.panel,
    '--raised': light ? colors.raisedLight : colors.raised,
    '--line': light ? colors.lineLight : colors.line,
    '--subtle-line': light ? colors.lineLight : colors.line,
    '--ink': light ? colors.inkLight : colors.inkDark,
    '--muted': light ? colors.mutedLight : colors.mutedDark,
    // Small desktop labels also sit on raised/selected surfaces: use the landing's
    // stronger secondary gray instead of its dim gray on those surfaces.
    '--dim': light ? colors.dimLight : colors.mutedDark,
    '--accent': colors.sky,
    '--blue': light ? colors.skyTextLight : colors.skyText,
    '--soft': light ? 'rgba(3, 105, 161, 0.1)' : 'rgba(108, 198, 236, 0.13)',
    '--selected-surface': light
      ? 'rgba(3, 105, 161, 0.1)'
      : 'rgba(108, 198, 236, 0.13)',
    '--selected-ink': light ? colors.skyTextLight : colors.skyText,
    '--focus': light ? colors.skyTextLight : colors.sky,
    '--primary-ink': colors.skyInk,
    '--warm': light ? colors.warmLight : colors.warm,
  };
}
