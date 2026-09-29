import { describe, expect, it } from 'vitest';
import { browserThemeColors, parseBrowserTheme } from '../browser-theme.js';

const theme = () => ({
  colors: Object.fromEntries(browserThemeColors.map(key => [key, 'rgb(25, 30, 35)'])),
  radius: '12px', fontFamily: '-apple-system, "Segoe UI", sans-serif', colorScheme: 'dark',
});

describe('browser theme appearance boundary', () => {
  it.each(['#2383e2', 'rgb(25, 30, 35)', 'rgba(0, 0, 0, 0.5)', 'oklch(0.7 0.2 250)', 'color(srgb 0.2 0.3 0.4)', 'color(display-p3 1 0.5 0 / 0.8)'])('accepts resolved color %s', color => {
    const input = theme(); input.colors.primary = color;
    expect(parseBrowserTheme(input)).toEqual(input);
  });
  it('copies only appearance keys, never arbitrary CSS', () => {
    const input = theme(); input.colors['background-image'] = 'url(https://example.com)';
    const parsed = parseBrowserTheme({ ...input, css: 'body { display:none }' });
    expect(parsed).toEqual(theme());
    input.colors.primary = '#ffffff';
    expect(parsed?.colors.primary).toBe('rgb(25, 30, 35)');
  });
  it.each(['url(https://example.com)', 'var(--secret)', 'red;display:none', 'rgb(0,0,0);background:url(x)', 'rgb(' + '1'.repeat(160) + ')'])('rejects non-color content %s', color => {
    const input = theme(); input.colors.primary = color;
    expect(parseBrowserTheme(input)).toBeNull();
  });
  it.each([null, 42, {}, { ...theme(), colors: {} }, { ...theme(), radius: '100px' },
    { ...theme(), radius: '-1px' }, { ...theme(), radius: 'url(x)' },
    { ...theme(), colorScheme: 'system' }, { ...theme(), fontFamily: 'url(https://example.com)' },
    { ...theme(), fontFamily: 'x; background: red' }])('rejects malformed appearance %j', input => {
    expect(parseBrowserTheme(input)).toBeNull();
  });
});
