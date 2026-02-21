import type { Plugin } from 'vite'
import type { Theme }  from './theme'

/**
 * A single CSS rule extracted from a `css({})` call by the Rust transform.
 *
 * - `hash`  — 8-character FNV-1a hex digest of the raw CSS content.
 *             Used as the virtual module ID (`virtual:css/<hash>.css`) and
 *             as the suffix of the generated class name (`cls_<hash>`).
 * - `css`   — Minified, browser-targeted CSS ready to be injected.
 */
export interface ExtractedCssRule {
  hash: string
  css: string
  map?: string
}

/**
 * A global CSS rule extracted from a `globalCss\`...\`` tagged template call.
 */
export interface GlobalCssRule {
  hash: string
  css: string
  map?: string
}

/**
 * A keyframes rule extracted from a `keyframes\`...\`` tagged template call.
 */
export interface KeyframeRule {
  hash: string
  name: string
  css: string
  map?: string
}

/**
 * The value returned by the Rust `transform()` function.
 *
 * - `code`      — The transformed JavaScript/TypeScript source.  Every
 *                 `css({…})` call has been replaced with its hashed class
 *                 name string literal.
 * - `cssRules`  — One entry per unique `css({})` call found in the file.
 */
export interface TransformResult {
  code: string
  cssRules: ExtractedCssRule[]
  globalCss: GlobalCssRule[]
  keyframes: KeyframeRule[]
  map?: string
}


// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface PigmentOptions {
  /**
   * The design-token theme passed to `css()` function calls at build time.
   * Colour scheme entries are emitted as CSS custom-property blocks.
   */
  theme?: Theme

  css?: {
    /**
     * Text direction for generated CSS.
     * @default 'ltr'
     */
    dir?: 'ltr' | 'rtl'
  }
}

/**
 * Zero-runtime CSS-in-JS Vite plugin factory.
 *
 * ```ts
 * import { defineConfig } from 'vite'
 * import { pigment }      from 'taikocss/vite'
 * import { yourTheme }    from './your-theme'
 *
 * export default defineConfig({
 *   plugins: [
 *     pigment({ theme: yourTheme }),
 *   ],
 * })
 * ```
 *
 * The plugin:
 * 1. Intercepts every `.js`, `.ts`, `.jsx`, and `.tsx` file at transform time.
 * 2. Calls the native Rust binary to parse the file with OXC and extract all
 *    static `css({})`, `globalCss\`...\``, and `keyframes\`...\`` calls.
 * 3. Resolves theme token references (`theme.colors.primary`) at compile time.
 * 4. Registers virtual CSS modules and prepends import statements.
 * 5. Emits colour scheme CSS custom-property blocks on `buildStart`.
 */
export declare function pigment(options?: PigmentOptions): Plugin

/**
 * @deprecated Use `pigment()` instead.
 */
export declare const rustCssPlugin: Plugin
