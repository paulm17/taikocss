import type { Plugin } from 'vite'

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
}

/**
 * Zero-runtime CSS-in-JS Vite plugin.
 *
 * Add it to your `vite.config.ts` plugins array:
 *
 * ```ts
 * import { rustCssPlugin } from 'my-css-engine/vite'
 *
 * export default {
 *   plugins: [rustCssPlugin],
 * }
 * ```
 *
 * The plugin:
 * 1. Intercepts every `.js`, `.ts`, `.jsx`, and `.tsx` file at transform time.
 * 2. Calls the native Rust binary to parse the file with OXC and extract all
 *    static `css({})` calls.
 * 3. Replaces each call with a hashed class name string literal.
 * 4. Registers a virtual CSS module (`virtual:css/<hash>.css`) containing
 *    the minified, browser-targeted CSS produced by LightningCSS.
 * 5. Prepends `import "virtual:css/<hash>.css"` statements to the transformed
 *    source so Vite injects the styles automatically.
 */
export declare const rustCssPlugin: Plugin