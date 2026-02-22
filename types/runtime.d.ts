/**
 * taikocss runtime — lightweight CSS injection at runtime.
 *
 * Framework-agnostic. No React, no framework dependency.
 * Uses the same conventions as the build-time css() function
 * (camelCase→kebab, px suffixing, FNV-1a hashing).
 */

/**
 * A CSS property value — either a string or a number.
 * Numbers are automatically suffixed with `px` unless the property is unitless
 * (e.g. `opacity`, `fontWeight`, `zIndex`).
 */
type CSSValue = string | number

/**
 * A recursive map of CSS properties and nested rules.
 *
 * Top-level keys are camelCase CSS property names.
 * String keys starting with `&`, `@`, or other non-identifier characters
 * are treated as nested selectors or at-rules.
 */
type CSSObject = {
    [key: string]: CSSValue | CSSObject | null | undefined
}

/**
 * Convert a style object to a CSS class at runtime.
 * Injects a `<style>` tag into the document and returns the class name.
 *
 * Supports nested selectors (`'&:hover'`), media queries, container queries,
 * number values (auto-suffixed with px unless unitless), and deep nesting.
 *
 * Uses the same FNV-1a hashing as the build-time `css()` function.
 * Same style object → same class name. Duplicate injections are cached.
 *
 * SSR-safe: if `document` is unavailable, returns the class name without
 * injecting (no DOM error).
 *
 * @param styles - CSS style object with camelCase property names.
 * @returns A class name string, e.g. `"stx_a3f9b2c1"`.
 *
 * @example
 * const cls = runtimeCss({ backgroundColor: 'red', padding: 16 })
 * // cls === "stx_f6cc53d2"
 */
export declare function runtimeCss(styles: CSSObject): string

/**
 * Inject global CSS at runtime (no class wrapper).
 * Keys are CSS selectors, values are style objects.
 *
 * @param styles - Object where keys are selectors and values are CSS properties.
 *
 * @example
 * runtimeGlobalCss({
 *   body: { margin: 0, fontFamily: 'Inter, sans-serif' },
 *   '*, *::before, *::after': { boxSizing: 'border-box' },
 * })
 */
export declare function runtimeGlobalCss(
    styles: Record<string, CSSObject>
): void

/**
 * Merge class names. Falsy values are ignored.
 *
 * @example
 * cx('cls_abc', isActive && 'stx_def', undefined, 'other')
 * // → "cls_abc stx_def other"  (if isActive is true)
 * // → "cls_abc other"          (if isActive is false)
 */
export declare function cx(
    ...args: Array<string | undefined | null | false | 0 | ''>
): string

/**
 * Internal: Serialize a style object into complete CSS text for a given class name.
 * Exported for testing purposes.
 */
export declare function _serializeCSS(
    className: string,
    styles: CSSObject
): string
