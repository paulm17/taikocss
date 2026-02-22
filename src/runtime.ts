// src/runtime.ts
//
// Lightweight runtime CSS injection for taikocss.
// Framework-agnostic — pure TypeScript, no React, no framework dependency.
// Uses only vanilla DOM APIs (guarded for SSR safety).
//
// Replaces @emotion/cache, @emotion/serialize, @emotion/utils, and @emotion/react
// with ~200 lines of code that uses the same conventions as the build-time css().

// ---------------------------------------------------------------------------
// Constants — must match lib.rs
// ---------------------------------------------------------------------------

const UNITLESS = new Set([
  'opacity',
  'z-index',
  'line-height',
  'flex',
  'flex-grow',
  'flex-shrink',
  'order',
  'font-weight',
  'tab-size',
  'orphans',
  'widows',
  'counter-increment',
  'counter-reset',
])

// ---------------------------------------------------------------------------
// camelCase → kebab-case  (matches lib.rs camel_to_kebab)
// ---------------------------------------------------------------------------

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
}

// ---------------------------------------------------------------------------
// Format a CSS value — numbers get px suffix unless unitless
// ---------------------------------------------------------------------------

function formatValue(property: string, value: string | number): string {
  if (typeof value === 'string') return value
  if (UNITLESS.has(property)) return String(value)
  if (value === 0) return '0'
  return value + 'px'
}

// ---------------------------------------------------------------------------
// FNV-1a 32-bit hash → 8 hex chars  (matches lib.rs hash_css)
// ---------------------------------------------------------------------------

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// CSS Serialization — style object → raw CSS string
// ---------------------------------------------------------------------------

/**
 * Serialize flat CSS declarations from a style object.
 * Returns only the property:value pairs, not the selector wrapper.
 * Nested rules (objects) are collected into a separate array.
 */
function serializeObject(
  obj: Record<string, unknown>,
  parentSelector: string,
  output: string[]
): string {
  let declarations = ''

  for (const key in obj) {
    const value = obj[key]

    if (value === null || value === undefined) continue

    if (typeof value === 'object' && !Array.isArray(value)) {
      // Nested rule
      const nested = value as Record<string, unknown>

      if (key.charAt(0) === '@') {
        // At-rule (@media, @container, @supports, etc.)
        // Declarations inside go under the parent selector
        const innerDecls = serializeObject(nested, parentSelector, output)
        if (innerDecls) {
          output.push(key + '{' + parentSelector + '{' + innerDecls + '}}')
        }
      } else {
        // Selector nesting — replace & with parent, or prefix with parent
        const resolvedSelector = key.indexOf('&') !== -1
          ? key.replace(/&/g, parentSelector)
          : parentSelector + ' ' + key
        const innerDecls = serializeObject(nested, resolvedSelector, output)
        if (innerDecls) {
          output.push(resolvedSelector + '{' + innerDecls + '}')
        }
      }
    } else {
      // CSS declaration
      const cssProperty = camelToKebab(key)
      const cssValue = formatValue(cssProperty, value as string | number)
      declarations += cssProperty + ':' + cssValue + ';'
    }
  }

  return declarations
}

/**
 * Serialize a style object into complete CSS text for a given class name.
 * Handles top-level declarations and nested selectors/at-rules.
 */
export function _serializeCSS(
  className: string,
  styles: Record<string, unknown>
): string {
  const selector = '.' + className
  const nestedBlocks: string[] = []
  const declarations = serializeObject(styles, selector, nestedBlocks)

  let css = ''
  if (declarations) {
    css += selector + '{' + declarations + '}'
  }
  if (nestedBlocks.length > 0) {
    css += nestedBlocks.join('')
  }
  return css
}

// ---------------------------------------------------------------------------
// Style injection — singleton <style> tags with deduplication
// ---------------------------------------------------------------------------

const cache = new Set<string>()

function injectStyle(hash: string, cssText: string): void {
  if (cache.has(hash)) return
  cache.add(hash)

  if (typeof document === 'undefined') return

  const style = document.createElement('style')
  style.setAttribute('data-taiko', hash)
  style.textContent = cssText
  document.head.appendChild(style)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
export function runtimeCss(styles: Record<string, unknown>): string {
  // Serialize to a temporary class to get the CSS text
  const tempClass = '__tmp__'
  const nestedBlocks: string[] = []
  const declarations = serializeObject(styles, '.' + tempClass, nestedBlocks)

  // Build the full CSS text with the temp class
  let fullCSS = ''
  if (declarations) {
    fullCSS += '.' + tempClass + '{' + declarations + '}'
  }
  if (nestedBlocks.length > 0) {
    fullCSS += nestedBlocks.join('')
  }

  // Hash the CSS content (with the temp class — so same styles = same hash)
  const hash = fnv1a(fullCSS)
  const className = 'stx_' + hash

  // Replace the temp class with the real class name
  const cssText = fullCSS.replace(/__tmp__/g, className)

  injectStyle(hash, cssText)
  return className
}

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
export function runtimeGlobalCss(styles: Record<string, unknown>): void {
  let css = ''

  for (const selector in styles) {
    const value = styles[selector]
    if (value === null || value === undefined) continue

    if (typeof value === 'object' && !Array.isArray(value)) {
      const nestedBlocks: string[] = []
      const declarations = serializeObject(
        value as Record<string, unknown>,
        selector,
        nestedBlocks
      )
      if (declarations) {
        css += selector + '{' + declarations + '}'
      }
      if (nestedBlocks.length > 0) {
        css += nestedBlocks.join('')
      }
    }
  }

  if (!css) return

  const hash = fnv1a(css)
  if (cache.has('g_' + hash)) return
  cache.add('g_' + hash)

  if (typeof document === 'undefined') return

  const style = document.createElement('style')
  style.setAttribute('data-taiko-global', hash)
  style.textContent = css
  document.head.appendChild(style)
}

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
export function cx(
  ...args: Array<string | undefined | null | false | 0 | ''>
): string {
  let result = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg) {
      if (result) result += ' '
      result += arg
    }
  }
  return result
}
