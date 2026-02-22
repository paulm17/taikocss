/**
 * Serialize a style object into complete CSS text for a given class name.
 * Handles top-level declarations and nested selectors/at-rules.
 */
export declare function _serializeCSS(className: string, styles: Record<string, unknown>): string;
/**
 * Convert a style object to a CSS class at runtime.
 * Injects a `<style>` tag into the document and returns the class name.
 *
 * @param styles - CSS style object with camelCase property names.
 *   Supports nested selectors (`'&:hover'`), media queries, container queries,
 *   number values (auto-suffixed with px unless unitless), and deep nesting.
 * @returns A class name string, e.g. `"stx_a3f9b2c1"`.
 *
 * @example
 * ```ts
 * import { runtimeCss } from 'taikocss/runtime'
 *
 * const cls = runtimeCss({ backgroundColor: 'red', padding: 16 })
 * // cls === "stx_f6cc53d2"
 * // Injects: <style data-taiko="f6cc53d2">.stx_f6cc53d2{background-color:red;padding:16px}</style>
 * ```
 */
export declare function runtimeCss(styles: Record<string, unknown>): string;
/**
 * Inject global CSS at runtime (no class wrapper).
 * Keys are CSS selectors, values are style objects.
 *
 * @param styles - Object where keys are selectors and values are CSS properties.
 *
 * @example
 * ```ts
 * import { runtimeGlobalCss } from 'taikocss/runtime'
 *
 * runtimeGlobalCss({
 *   body: { margin: 0, fontFamily: 'Inter, sans-serif' },
 *   '*, *::before, *::after': { boxSizing: 'border-box' },
 * })
 * ```
 */
export declare function runtimeGlobalCss(styles: Record<string, unknown>): void;
/**
 * Merge class names. Falsy values are ignored.
 *
 * @example
 * ```ts
 * cx('cls_abc', isActive && 'stx_def', undefined, 'other')
 * // → "cls_abc stx_def other"  (if isActive is true)
 * // → "cls_abc other"          (if isActive is false)
 * ```
 */
export declare function cx(...args: Array<string | undefined | null | false | 0 | ''>): string;
//# sourceMappingURL=runtime.d.ts.map