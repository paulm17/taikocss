// plugin.d.ts
import type { Plugin } from 'vite'
import type { Theme } from './types/theme'

export interface TaikoOptions {
  /**
   * Design token theme. Passed to `css(({ theme }) => …)` calls at build time.
   * The theme object is never shipped to the browser.
   */
  theme?: Theme

  css?: {
    /**
     * Text direction for the generated CSS.
     * @default 'ltr'
     */
    defaultDirection?: 'ltr' | 'rtl'

    /**
     * When true, generate CSS for both LTR and RTL directions.
     * @default false
     */
    generateForBothDir?: boolean
  }
}

/**
 * Create the zero-runtime CSS Vite plugin.
 *
 * @example
 * // vite.config.ts
 * import { defineConfig } from 'vite'
 * import { taiko }      from 'taikocss/vite'
 * import { myTheme }      from './src/theme'
 *
 * export default defineConfig({
 *   plugins: [taiko({ theme: myTheme })],
 * })
 */
export declare function taiko(options?: TaikoOptions): Plugin

/**
 * @deprecated Use `taiko()` instead.
 */
export declare const rustCssPlugin: Plugin