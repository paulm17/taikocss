import type { Theme } from './theme'

/**
 * A CSS property value — either a string (e.g. 'blue', '8px 16px') or a
 * number (automatically given a `px` suffix unless the property is unitless).
 */
type CSSValue = string | number

/**
 * A recursive map of CSS properties and nested rules.
 *
 * Top-level keys should be camelCase CSS property names
 * (e.g. `backgroundColor`, `fontSize`).
 *
 * String keys that start with `&`, `:`, `@`, or any other non-identifier
 * character are treated as nested selectors or at-rules:
 *
 * ```ts
 * css({
 *   color: 'red',
 *   '&:hover': { color: 'darkred' },
 *   '@media (max-width: 600px)': { fontSize: 14 },
 *   '@container sidebar (max-width: 300px)': { display: 'none' },
 * })
 * ```
 *
 * **Constraint:** all values must be statically known at build time.
 * The Vite plugin will throw if it encounters a runtime variable.
 */
type CSSProperties = {
  [Property in keyof CSSStyleDeclaration]?: CSSValue
} & {
  /** Nested selectors (e.g. `'&:hover'`), at-rules, and container queries. */
  [key: string]: CSSValue | CSSProperties
}

// ---------------------------------------------------------------------------
// Theming
// ---------------------------------------------------------------------------

interface ThemeArg {
  theme: Theme
}

/**
 * A factory function that receives `{ theme }` and returns a CSS properties
 * object. Evaluated at build time — the result must be a static object literal.
 *
 * @example
 * const title = css(({ theme }) => ({
 *   color: theme.colors.primary,
 *   fontSize: theme.spacing.unit * 4,
 * }))
 */
type StyleFactory = (arg: ThemeArg) => CSSProperties

// ---------------------------------------------------------------------------
// css()
// ---------------------------------------------------------------------------

/**
 * Define a CSS class from a static style object or theme factory.
 *
 * At **build time** every call is replaced with a stable, content-hashed class
 * name string — e.g. `"cls_f6cc53d2"` — and the corresponding CSS is injected
 * as a virtual module. Zero runtime overhead.
 *
 * At **runtime** (Jest, Vitest in node mode, `ts-node`) the shim in
 * `src/css.ts` is used instead, which returns `''`.
 *
 * @param styles - A static object of CSS properties, or a theme factory
 *   function `({ theme }) => ({ ... })`.
 * @returns The hashed class name string (at build time) or `''` (at runtime).
 *
 * @example
 * // Static object form
 * const button = css({
 *   backgroundColor: 'oklch(60% .2 250)',
 *   borderRadius: 4,
 *   padding: '8px 16px',
 *   '&:hover': { backgroundColor: 'oklch(50% .2 250)' },
 * })
 *
 * @example
 * // Theme factory form
 * const title = css(({ theme }) => ({
 *   color: theme.colors.primary,
 *   fontFamily: theme.typography.fontFamily,
 * }))
 */
export declare function css(styles: CSSProperties | StyleFactory): string

// ---------------------------------------------------------------------------
// globalCss
// ---------------------------------------------------------------------------

/**
 * Inject global CSS at build time.
 *
 * The tagged template literal is processed by LightningCSS — minified,
 * vendor-prefixed, and syntax-lowered. Interpolations must be static string
 * or number values (or theme token expressions).
 *
 * The call is replaced with `undefined` in the output; the Vite plugin hoists
 * a `import "virtual:css/global-<hash>.css"` statement to the top of the file.
 *
 * @example
 * globalCss`
 *   *, *::before, *::after { box-sizing: border-box; }
 *   body { margin: 0; font-family: ${theme.typography.fontFamily}; }
 * `
 */
export declare function globalCss(
  strings: TemplateStringsArray,
  ...values: Array<string | number>
): void

// ---------------------------------------------------------------------------
// keyframes
// ---------------------------------------------------------------------------

/**
 * Define a CSS `@keyframes` animation at build time.
 *
 * Returns the hashed animation name string — e.g. `"kf_a3f9b2c1"` — which
 * can be interpolated into `css()` string values:
 *
 * ```ts
 * const fadeIn = keyframes`
 *   from { opacity: 0; }
 *   to   { opacity: 1; }
 * `
 * const el = css({ animation: `${fadeIn} 0.5s ease-out` })
 * ```
 *
 * The `keyframes` declaration must textually precede any `css()` call that
 * references it in the same file.
 */
export declare function keyframes(
  strings: TemplateStringsArray,
  ...values: Array<string | number>
): string

// ---------------------------------------------------------------------------
// container()
// ---------------------------------------------------------------------------

type ContainerType = 'size' | 'inline-size' | 'block-size' | 'normal'

/**
 * Declare a CSS containment context. Spread into a `css()` call to define
 * which container subsequent `@container` queries target.
 *
 * Expanded at build time — zero runtime cost.
 *
 * @example
 * const sidebar = css({
 *   ...container('sidebar', 'inline-size'),
 *   width: '250px',
 * })
 *
 * const card = css({
 *   '@container sidebar (max-width: 300px)': { display: 'none' },
 * })
 */
export declare function container(name: string, type: ContainerType): CSSProperties
export declare function container(type: ContainerType): CSSProperties