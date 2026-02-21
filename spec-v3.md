# Zero-Runtime CSS Engine: Taikocss — v3 Spec

This document specifies the next phase of features: theming, global styles,
keyframes, and container queries. It builds on the v2 foundation (OXC parser,
LightningCSS, NAPI-RS, Vite plugin, source maps, HMR).

---

## 1. Theming

### 1.1 Problem

Components that call `css({})` today write raw values inline. There is no way
to share a design token (a colour, a spacing unit, a font stack) across
multiple components, or to switch between visual modes (light/dark, branded
colour schemes) without touching every call site.

### 1.2 Design goals

- Theme values must be **statically resolvable at build time** so the Rust
  core can continue to produce hashed, zero-runtime CSS.
- The theme object lives in `vite.config.js`/`vite.config.ts` — one source of
  truth, no separate config file.
- Multiple named colour schemes (e.g. `obnoxiousBrown`) each with `light` and
  `dark` variants are first-class citizens.
- The `css()` call site syntax changes to accept a **function** that receives
  `{ theme }`, mirroring the pattern used by Pigment CSS and Emotion:

```ts
const title = css(({ theme }) => ({
  color: theme.colors.primary,
  fontSize: theme.spacing.unit * 4,
  fontFamily: theme.typography.fontFamily,
}))
```

### 1.3 Theme shape

```ts
// types/theme.d.ts

type CSSValue = string | number

interface ColorTokens {
  [key: string]: CSSValue
}

interface SpacingTokens {
  unit: number
  [key: string]: CSSValue
}

interface TypographyTokens {
  fontFamily?: string
  fontSize?: CSSValue
  fontWeight?: CSSValue
  lineHeight?: CSSValue
  [key: string]: CSSValue | undefined
}

interface ColorSchemeVariant {
  colors?: ColorTokens
  [key: string]: Record<string, CSSValue> | undefined
}

interface ColorScheme {
  light?: ColorSchemeVariant
  dark?:  ColorSchemeVariant
}

export interface Theme {
  colors?:       ColorTokens
  spacing?:      SpacingTokens
  typography?:   TypographyTokens
  /** Named colour schemes, each with optional light/dark variants. */
  colorSchemes?: Record<string, ColorScheme>
}
```

**Example theme:**

```ts
// your-theme.ts
import type { Theme } from 'my-css-engine'

export const yourTheme: Theme = {
  colors: {
    primary:   'tomato',
    secondary: 'cyan',
  },
  spacing: {
    unit: 8,
  },
  typography: {
    fontFamily: 'Inter, sans-serif',
  },
  colorSchemes: {
    obnoxiousBrown: {
      light: {
        colors: {
          background: '#f9f9f9',
          foreground: '#121212',
        },
      },
      dark: {
        colors: {
          background: '#212121',
          foreground: '#fff',
        },
      },
    },
  },
}
```

### 1.4 Vite plugin configuration

The plugin entry point changes from a bare object to a factory function
`pigment()` that accepts options:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { pigment }      from 'my-css-engine/vite'
import { yourTheme }    from './your-theme'

export default defineConfig({
  plugins: [
    pigment({
      theme: yourTheme,
      css: {
        defaultDirection:    'ltr',
        generateForBothDir:  false,
      },
    }),
  ],
})
```

#### `pigment(options)` option shape

```ts
interface PigmentOptions {
  /** The design-token theme passed to css() function calls. */
  theme?: Theme

  css?: {
    /**
     * The default text direction for generated CSS.
     * @default 'ltr'
     */
    defaultDirection?: 'ltr' | 'rtl'

    /**
     * When true, emit both LTR and RTL variants of every rule.
     * LightningCSS handles the logical-property lowering.
     * @default false
     */
    generateForBothDir?: boolean
  }
}
```

### 1.5 Rust core changes

#### 1.5a Accepting a function argument

The `transform` NAPI export gains a `theme_json` parameter — the theme
serialised to a JSON string by the Vite plugin before the call. The Rust core
deserialises it with `serde_json`.

```rust
#[napi]
pub fn transform(
    filename:    String,
    source_code: String,
    theme_json:  Option<String>,   // ← new
) -> Result<TransformResult>
```

#### 1.5b Detecting the function-argument form

When the walker encounters `css(arg)` and `arg` is an
`ArrowFunctionExpression` (or `FunctionExpression`) whose parameter is a
destructured `{ theme }`, it evaluates the body **at compile time** using the
provided theme object rather than the raw AST values.

The function body must return an `ObjectExpression`. Anything more complex
(conditional expressions, multiple statements, loops) is rejected with a
rich error message.

#### 1.5c Static theme evaluation

The theme is parsed into a `serde_json::Value` tree. When evaluating a
`MemberExpression` like `theme.colors.primary`, the walker traverses the
JSON tree along the member chain and substitutes the concrete value
(`"tomato"`) before passing the object to `object_to_css`.

Arithmetic expressions on theme values (`theme.spacing.unit * 4`) are
evaluated for the common binary operators `+`, `-`, `*`, `/` when both
operands are statically known numbers. The result is a numeric literal and
follows the existing px-suffix rules.

**Supported at build time:**

| Expression | Example | Result |
|---|---|---|
| String member | `theme.colors.primary` | `"tomato"` |
| Number member | `theme.spacing.unit` | `8` |
| Multiply | `theme.spacing.unit * 4` | `32` → `32px` |
| Add | `theme.spacing.unit + 2` | `10` → `10px` |
| Concatenate | `` `${theme.typography.fontFamily}` `` | `"Inter, sans-serif"` |
| String concat | `theme.colors.primary + ' !important'` | `"tomato !important"` |

**Rejected at build time (error with file:line:col):**

- `theme.colors[dynamicKey]` — computed member access
- Ternary or conditional expressions
- Function calls within the css body (other than the outer arrow)
- Member chains that don't resolve to a leaf value in the theme

#### 1.5d Colour scheme CSS variable emission

Each named colour scheme produces a block of CSS custom properties scoped
under a `data-` attribute selector, emitted as a separate virtual CSS module
(`virtual:css/theme-<schemeName>-<mode>.css`):

```css
/* virtual:css/theme-obnoxiousBrown-light.css */
[data-color-scheme="obnoxiousBrown"][data-mode="light"] {
  --colors-background: #f9f9f9;
  --colors-foreground: #121212;
}

/* virtual:css/theme-obnoxiousBrown-dark.css */
[data-color-scheme="obnoxiousBrown"][data-mode="dark"] {
  --colors-background: #212121;
  --colors-foreground: #fff;
}
```

The plugin emits these modules once at startup (in `buildStart`) and registers
them with `cssMap`. They are not re-emitted on HMR unless the theme object
itself changes (detected by hashing the serialised theme).

#### 1.5e TypeScript type for `css()` with theme

```ts
// types/css.d.ts (additions)

interface ThemeArg {
  theme: Theme
}

type StyleFactory = (arg: ThemeArg) => CSSProperties

export declare function css(styles: CSSProperties | StyleFactory): string
```

### 1.6 RTL / bidirectional support

When `generateForBothDir: true`, the Vite plugin passes the option through to
`transform()` and LightningCSS's `PrinterOptions` is called twice — once with
`targets` as-is (LTR), and once with logical-property direction flipped (RTL).
The two outputs are emitted as separate virtual CSS modules:

- `virtual:css/<hash>-ltr.css`
- `virtual:css/<hash>-rtl.css`

Both are imported in the transformed JS. The active direction is controlled
at runtime by `<html dir="rtl">` or a CSS selector — the engine does not add
any runtime JavaScript.

---

## 2. Global Styles

### 2.1 Problem

There is no way to inject page-level CSS (resets, base typography, custom
property declarations, third-party overrides) through the same pipeline.
Users currently have to maintain a separate `.css` file that sits outside
the zero-runtime flow.

### 2.2 API

```ts
import { globalCss } from 'my-css-engine'

globalCss`
  *, *::before, *::after {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    padding: 0;
    font-family: ${theme.typography.fontFamily};
  }
`
```

`globalCss` is a **tagged template literal**. Interpolations must be
statically resolvable strings or numbers (same rule as `css()`). Dynamic
runtime values are a build error.

### 2.3 Vite plugin handling

The Rust `transform()` function detects `globalCss` tagged template calls.
For each call it:

1. Collects the template string parts and interpolated values (which must
   be string or numeric literals in the AST).
2. Concatenates them into a raw CSS string.
3. Passes the raw CSS through LightningCSS for validation, minification, and
   syntax lowering (same pipeline as `css()`).
4. Emits a virtual CSS module: `virtual:css/global-<hash>.css`.
5. Replaces the `globalCss\`...\`` call in the JS output with
   `import "virtual:css/global-<hash>.css"` hoisted to the top of the file,
   and replaces the call expression itself with `undefined`.

### 2.4 Rust core changes

New AST walker branch for `TaggedTemplateExpression` where the tag is the
identifier `globalCss`.

```rust
// New NAPI type
#[napi(object)]
pub struct GlobalCssRule {
    pub hash: String,
    pub css:  String,
    pub map:  Option<String>,
}

// TransformResult gains a new field
#[napi(object)]
pub struct TransformResult {
    pub code:            String,
    pub css_rules:       Vec<ExtractedCssRule>,
    pub global_css:      Vec<GlobalCssRule>,   // ← new
    pub map:             Option<String>,
}
```

### 2.5 Ordering guarantee

Global CSS modules are always imported before component-level CSS modules in
the transformed output. Within a single file, multiple `globalCss` calls
preserve source order.

### 2.6 TypeScript declaration

```ts
// types/css.d.ts (additions)

/**
 * Inject global CSS at build time.  The template literal is processed by
 * LightningCSS — minified, vendor-prefixed, and syntax-lowered.
 * Interpolations must be static string or number values.
 *
 * @example
 * globalCss`
 *   body { margin: 0; font-family: ${theme.typography.fontFamily}; }
 * `
 */
export declare function globalCss(
  strings: TemplateStringsArray,
  ...values: Array<string | number>
): void
```

---

## 3. Keyframes

### 3.1 Problem

Animations require `@keyframes` declarations. These are currently impossible
to express through the engine — users must either write raw CSS files or use
inline `style` props, losing the minification, hashing, and HMR benefits.

### 3.2 API

```ts
import { keyframes } from 'my-css-engine'

const fadeIn = keyframes`
  from { opacity: 0; }
  to   { opacity: 1; }
`

const slideUp = keyframes`
  from { transform: translateY(20px); opacity: 0; }
  to   { transform: translateY(0);    opacity: 1; }
`

function Example() {
  return (
    <div className={css({ animation: `${fadeIn} 0.5s ease-out` })}>
      Hello
    </div>
  )
}
```

`keyframes` is also a tagged template literal. The return value is the
hashed animation name string — e.g. `"kf_a3f9b2c1"` — which can be
interpolated into `css()` string values or `style` props.

### 3.3 Rust core changes

The `transform()` walker detects `keyframes` tagged template calls. For each:

1. Collects and concatenates the template parts (interpolations must be
   static strings or numbers).
2. Wraps in `@keyframes __placeholder__ { … }`.
3. Passes through LightningCSS for validation and minification.
4. Hashes the minified content → `kf_<hash>` animation name.
5. Replaces the placeholder name with `kf_<hash>` in the CSS output.
6. Replaces the `keyframes\`...\`` call expression in JS with the string
   literal `"kf_<hash>"`.
7. Emits `virtual:css/kf-<hash>.css`.

```rust
// New NAPI type
#[napi(object)]
pub struct KeyframeRule {
    pub hash: String,   // the hex suffix, without "kf_"
    pub name: String,   // the full animation name: "kf_<hash>"
    pub css:  String,   // the full @keyframes block, minified
    pub map:  Option<String>,
}

// TransformResult gains a new field
#[napi(object)]
pub struct TransformResult {
    pub code:        String,
    pub css_rules:   Vec<ExtractedCssRule>,
    pub global_css:  Vec<GlobalCssRule>,
    pub keyframes:   Vec<KeyframeRule>,    // ← new
    pub map:         Option<String>,
}
```

### 3.4 Interpolation into `css()` values

When a `css()` value string contains a `keyframes` reference —
`` animation: `${fadeIn} 0.5s` `` — the walker evaluates the template
literal at build time. If `fadeIn` was already resolved to `"kf_a3f9b2c1"`
earlier in the same file, the concatenated value `"kf_a3f9b2c1 0.5s"` is
used. If the reference cannot be resolved statically, a build error is thrown.

This means `keyframes` declarations must textually precede any `css()` call
that references them within the same file.

### 3.5 TypeScript declaration

```ts
// types/css.d.ts (additions)

/**
 * Define a CSS @keyframes animation at build time.
 * Returns the hashed animation name string (e.g. "kf_a3f9b2c1").
 * Interpolations must be static string or number values.
 *
 * @example
 * const fadeIn = keyframes`
 *   from { opacity: 0; }
 *   to   { opacity: 1; }
 * `
 * // At build time: const fadeIn = "kf_a3f9b2c1"
 */
export declare function keyframes(
  strings: TemplateStringsArray,
  ...values: Array<string | number>
): string
```

---

## 4. Container Queries

### 4.1 Problem

Container queries (`@container`) are already valid in `css()` object keys
(they fall through as nested object keys) and pass through LightningCSS today.
However, the LightningCSS browser targets used in `process_css_object` do not
enable container query syntax lowering, and there is no way to declare a
**containment context** from within the engine.

### 4.2 API — authoring (already works, clarify the spec)

```ts
const styles = css({
  fontSize: '2rem',

  // Standard media query — already supported
  '@media (min-width: 768px)': {
    fontSize: '3rem',
  },

  // Container query — supported from this version
  '@container (max-width: 768px)': {
    fontSize: '1.5rem',
  },

  // Named container query
  '@container sidebar (max-width: 300px)': {
    display: 'none',
  },
})
```

No API change is required for authoring — container query keys already pass
through `object_to_css` as nested block rules. The change is in how
LightningCSS processes them.

### 4.3 Containment context declaration

To define a named container, use a dedicated `container` helper that emits the
`container-type` and optional `container-name` declarations:

```ts
import { css, container } from 'my-css-engine'

// Declare a containment context
const sidebar = css({
  ...container('sidebar', 'inline-size'),
  width: '250px',
})

// Then query it
const card = css({
  '@container sidebar (max-width: 300px)': {
    display: 'none',
  },
})
```

`container(name?, type)` is a **compile-time helper** — it expands to a plain
object at build time and never exists at runtime:

```ts
// Equivalent expansion at build time:
container('sidebar', 'inline-size')
// → { containerType: 'inline-size', containerName: 'sidebar' }
```

The Rust walker recognises `container(...)` call expressions inside object
spread positions and inlines the expansion before processing.

### 4.4 Rust core changes

#### 4.4a LightningCSS targets update

Add container query support to the browser targets in `process_css_object`:

```rust
let targets = Targets {
    browsers: Some(Browsers {
        chrome:  Some(105 << 16),  // Chrome 105 = first stable container queries
        safari:  Some(16 << 16),
        firefox: Some(110 << 16),
        ..Browsers::default()
    }),
    ..Targets::default()
};
```

With these targets, LightningCSS will:
- Pass through `@container` rules natively (supported by all three browsers).
- Polyfill or warn for features not yet supported by the targets.

#### 4.4b `container()` call inlining

The walker detects `container(name, type)` or `container(type)` call
expressions appearing as spread elements inside an object passed to `css()`.
It expands them to `{ containerType: type, containerName: name }` properties
before `object_to_css` processes the object.

```rust
// In the spread handling branch of object_to_css:
ObjectPropertyKind::SpreadProperty(spread) => {
    if let Expression::CallExpression(call) = &spread.argument {
        if is_container_call(call) {
            // inline the expansion — no error
            let props = expand_container_call(call, filename, source)?;
            css.push_str(&props);
            continue;
        }
    }
    // All other spreads remain a build error
    return Err(/* spread error */);
}
```

### 4.5 TypeScript declaration

```ts
// types/css.d.ts (additions)

type ContainerType = 'size' | 'inline-size' | 'block-size' | 'normal'

/**
 * Declare a CSS containment context. Use inside a `css()` call to define
 * which container subsequent `@container` queries target.
 *
 * Expanded at build time — zero runtime cost.
 *
 * @example
 * const sidebar = css({
 *   ...container('sidebar', 'inline-size'),
 *   width: '250px',
 * })
 */
export declare function container(
  name: string,
  type: ContainerType
): CSSProperties

export declare function container(type: ContainerType): CSSProperties
```

---

## 5. Updated `TransformResult` (full shape after all v3 changes)

```rust
#[napi(object)]
pub struct TransformResult {
    /// Transformed JS source with all css()/globalCss`…`/keyframes`…` calls replaced.
    pub code: String,

    /// One entry per css({}) or css(({theme}) => ({})) call.
    pub css_rules: Vec<ExtractedCssRule>,

    /// One entry per globalCss`…` tagged template call.
    pub global_css: Vec<GlobalCssRule>,

    /// One entry per keyframes`…` tagged template call.
    pub keyframes: Vec<KeyframeRule>,

    /// V3 source map JSON for the transformed JS.
    pub map: Option<String>,
}
```

---

## 6. Updated Vite plugin shape

```ts
// types/vite.d.ts (v3)

import type { Plugin } from 'vite'
import type { Theme }  from './theme'

export interface PigmentOptions {
  theme?: Theme
  css?: {
    defaultDirection?:   'ltr' | 'rtl'
    generateForBothDir?: boolean
  }
}

/**
 * Create the zero-runtime CSS Vite plugin with optional theme and CSS options.
 *
 * @example
 * import { pigment } from 'my-css-engine/vite'
 * export default { plugins: [pigment({ theme: yourTheme })] }
 */
export declare function pigment(options?: PigmentOptions): Plugin
```

The existing `rustCssPlugin` bare export is kept for backwards compatibility
but deprecated in favour of `pigment()`.

---

## 7. Test coverage additions (v3)

| Scenario | Expected behaviour |
|---|---|
| `css(({ theme }) => ({ color: theme.colors.primary }))` | Resolved to `"tomato"`, correct CSS emitted |
| `css(({ theme }) => ({ fontSize: theme.spacing.unit * 4 }))` | `32` → `32px` |
| Theme member that doesn't exist | Build error with file:line:col |
| Computed theme member (`theme.colors[key]`) | Build error |
| `globalCss\`body { margin: 0 }\`` | Virtual global CSS module emitted |
| `globalCss` with static interpolation | Correctly concatenated |
| `globalCss` with dynamic interpolation | Build error |
| `keyframes\`from{opacity:0}to{opacity:1}\`` | Virtual keyframes module, name string returned |
| `keyframes` name interpolated into `css()` | Correctly resolved to hashed name |
| `@container` rule in `css()` object | Passed through and minified by LightningCSS |
| `container('sidebar', 'inline-size')` spread | Expanded to `container-type`/`container-name` properties |
| Two identical `keyframes` bodies | Same hash, single virtual module |
| `generateForBothDir: true` | Two virtual modules per rule (LTR + RTL) |
| Theme colour scheme CSS variables | Emitted on `buildStart`, correct selectors |
| HMR after theme change | Theme CSS variable modules invalidated |

---

## 8. Priority order

1. **Theming (base tokens)** — unlocks the primary use case; moderate Rust + JS changes
2. **`keyframes`** — tagged template, self-contained, no dependencies on theming
3. **`globalCss`** — tagged template, straightforward once keyframes pattern exists
4. **Container queries** — LightningCSS target bump + `container()` inlining
5. **Colour schemes** — depends on theming foundation; emits CSS custom properties
6. **RTL / bidirectional** — depends on theming + LightningCSS; lower priority
7. **Test coverage** — ongoing alongside each feature