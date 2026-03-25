import type { CSSProperties } from 'vue';

/** Visible frame so fill-mode widgets (PDF bitmap) stay recognizable in viewers that lock the form category. */
export function formFieldChromeStyle(isFocused: boolean): Pick<CSSProperties, 'boxSizing' | 'boxShadow'> {
  return {
    boxSizing: 'border-box',
    boxShadow: isFocused
      ? 'inset 0 0 0 3px rgba(37, 99, 235, 0.95)'
      : 'inset 0 0 0 2px rgba(37, 99, 235, 0.72)',
  };
}
