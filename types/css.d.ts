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
 * })
 * ```
 *
 * **Constraint:** all values must be statically known at build time.
 * The Vite plugin will throw if it encounters a runtime variable.
 */
type CSSProperties = {
  [Property in keyof CSSStyleDeclaration]?: CSSValue
} & {
  /** Nested selectors (e.g. `'&:hover'`) and at-rules (e.g. `'@media …'`). */
  [key: string]: CSSValue | CSSProperties
}

/**
 * Define a CSS class from a static style object.
 *
 * At **build time** (when processed by the Vite plugin) every call is replaced
 * with a stable, content-hashed class name string — e.g. `"cls_f6cc53d2"` —
 * and the corresponding CSS is injected as a virtual module. The function call
 * itself is erased; zero runtime overhead.
 *
 * At **runtime** (Jest, Vitest in node mode, `ts-node`, Storybook without the
 * plugin) the shim in `src/css.ts` is used instead, which returns `''` so that
 * components render without styles rather than crashing.
 *
 * @param styles - A static object of CSS properties and/or nested rules.
 * @returns The hashed class name string (at build time) or `''` (at runtime).
 *
 * @example
 * import { css } from './css'
 *
 * const button = css({
 *   backgroundColor: 'oklch(60% .2 250)',
 *   borderRadius: 4,
 *   padding: '8px 16px',
 *   '&:hover': {
 *     backgroundColor: 'oklch(50% .2 250)',
 *   },
 *   '@media (max-width: 600px)': {
 *     padding: '4px 8px',
 *   },
 * })
 * // At build time: const button = "cls_f6cc53d2"
 */
export declare function css(styles: CSSProperties): string