import { describe, expect, it } from 'vitest';
import { browserThemeColors, type BrowserTheme } from '../browser-theme.js';
import { TITLE_BAR_OVERLAY_HEIGHT, defaultTitleBarOverlay, opaqueHex, titleBarOverlayFromTheme } from '../title-bar-overlay.js';

const theme = (overrides: Partial<BrowserTheme['colors']> = {}, colorScheme: 'light' | 'dark' = 'light'): BrowserTheme => ({
  colors: { ...Object.fromEntries(browserThemeColors.map(key => [key, 'rgb(0, 0, 0)'])), ...overrides } as BrowserTheme['colors'],
  colorScheme, radius: '8px', fontFamily: 'sans-serif',
});

describe('[COMP:app-desktop/title-bar-overlay] Windows window-controls overlay', () => {
  it.each([
    ['rgb(247, 247, 245)', '#f7f7f5'],
    ['rgba(32, 32, 32, 1)', '#202020'],
    ['rgb(32 32 32 / 100%)', '#202020'],
  ])('normalizes opaque %s to hex', (input, hex) => {
    expect(opaqueHex(input)).toBe(hex);
  });

  it.each(['rgba(0, 0, 0, 0.5)', 'rgb(0 0 0 / 50%)', 'oklch(0.7 0.2 250)', 'color(srgb 0.2 0.3 0.4)', 'rgb(300, 0, 0)', 'red'])(
    'refuses %s (translucent or not parseable by the overlay)', input => {
      expect(opaqueHex(input)).toBeNull();
    });

  it('matches the top row: sidebar surface + sidebar foreground', () => {
    const overlay = titleBarOverlayFromTheme(theme({ sidebar: 'rgb(247, 247, 245)', 'sidebar-foreground': 'rgb(55, 53, 47)' }));
    expect(overlay).toEqual({ color: '#f7f7f5', symbolColor: '#37352f', height: TITLE_BAR_OVERLAY_HEIGHT });
  });

  it('falls back to the scheme default for colors it cannot read', () => {
    const overlay = titleBarOverlayFromTheme(theme({ sidebar: 'oklch(0.2 0 0)', 'sidebar-foreground': 'oklch(0.9 0 0)' }, 'dark'));
    expect(overlay).toEqual(defaultTitleBarOverlay(true));
  });

  it('keeps the overlay as tall as the app top row', () => {
    expect(defaultTitleBarOverlay(false).height).toBe(44);
  });
});
