# taikocss

A zero-runtime CSS-in-JS library powered by Rust, [OXC](https://oxc.rs), and [LightningCSS](https://lightningcss.dev). Every `css()` call is extracted at **build time** — the browser receives plain, minified, hashed CSS with no JavaScript overhead at runtime.

```ts
import { css } from 'taikocss'

const button = css({
  backgroundColor: 'tomato',
  borderRadius: 4,
  padding: '8px 16px',
  '&:hover': { backgroundColor: 'darkred' },
  '@media (max-width: 600px)': { padding: '4px 8px' },
})

// At build time this file becomes:
// const button = "cls_f6cc53d2"
// + an injected import of the virtual CSS module
```

---

## How it works

The Vite plugin intercepts every `.js`, `.ts`, `.jsx`, and `.tsx` file during the build. It calls a native Rust binary (via [NAPI-RS](https://napi.rs)) that parses the file with OXC, walks the AST to find `css()`, `globalCss`, `keyframes`, and `container()` calls, evaluates them statically, and hands the resulting CSS to LightningCSS for minification, syntax lowering, and vendor prefixing. The output is injected as virtual CSS modules that Vite handles like any other CSS import.

Nothing runs in the browser except the styles themselves.

---

## Requirements

- Node.js 18 or later
- Vite 4, 5, or 6
- A supported platform: macOS (Apple Silicon or Intel), Linux (x64 or ARM64), Windows (x64)

---

## Installation

```bash
npm install taikocss
# or
pnpm add taikocss
# or
yarn add taikocss
```

No Rust toolchain is required — the native binary ships prebuilt for all supported platforms.

---

## Quick start

### 1. Configure Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { pigment } from 'taikocss/vite'

export default defineConfig({
  plugins: [pigment()],
})
```

### 2. Write a component

```tsx
// Button.tsx
import { css } from 'taikocss'

const styles = css({
  backgroundColor: 'steelblue',
  color: '#fff',
  borderRadius: 4,
  padding: '8px 16px',
  border: 'none',
  cursor: 'pointer',
})

export function Button({ children }: { children: React.ReactNode }) {
  return <button className={styles}>{children}</button>
}
```

### 3. Run the dev server

```bash
npm run dev
```

Styles update instantly on save via HMR — no full page reload for CSS-only changes.

---

## Vite plugin options

The `pigment()` factory accepts an optional configuration object.

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { pigment } from 'taikocss/vite'
import { myTheme } from './src/theme'

export default defineConfig({
  plugins: [
    pigment({
      // Design token theme — passed into css() function calls at build time.
      theme: myTheme,

      css: {
        // Default text direction for generated CSS.
        // Default: 'ltr'
        defaultDirection: 'ltr',

        // When true, emit both LTR and RTL variants of every rule.
        // Useful for internationalised applications.
        // Default: false
        generateForBothDir: false,
      },
    }),
  ],
})
```

### Full option reference

| Option | Type | Default | Description |
|---|---|---|---|
| `theme` | `Theme` | — | Design token object passed to `css(({ theme }) => …)` calls |
| `css.defaultDirection` | `'ltr' \| 'rtl'` | `'ltr'` | Default text direction |
| `css.generateForBothDir` | `boolean` | `false` | Emit both LTR and RTL CSS modules per rule |

---

## Core API

### `css(styles)`

Define a CSS class from a static style object. Returns the hashed class name string at build time.

```ts
import { css } from 'taikocss'

const card = css({
  backgroundColor: '#fff',
  borderRadius: 8,
  padding: 24,                      // numbers → px (except unitless props)
  boxShadow: '0 2px 8px #0002',
  fontWeight: 700,                   // unitless — no px suffix
  opacity: 1,                        // unitless — no px suffix
})
```

**Nesting and at-rules** are supported as nested objects:

```ts
const link = css({
  color: 'steelblue',
  textDecoration: 'none',

  '&:hover': {
    textDecoration: 'underline',
  },

  '&:focus-visible': {
    outline: '2px solid steelblue',
    outlineOffset: 2,
  },

  '@media (prefers-color-scheme: dark)': {
    color: 'skyblue',
  },
})
```

**All values must be static.** Using a runtime variable is a build error with the file, line, and column clearly reported:

```ts
const size = computedValue()
const bad = css({ fontSize: size })
// Error: src/Component.tsx:3:28: css() — only static values are supported
// Hint: extract the value to a constant or use a CSS variable.
```

---

## Theming

### Defining a theme

Create a theme file and export it. The theme is consumed at build time — it never ships to the browser.

```ts
// src/theme.ts
import type { Theme } from 'taikocss'

export const myTheme: Theme = {
  colors: {
    primary:    'tomato',
    secondary:  'cyan',
    muted:      '#6c757d',
    background: '#ffffff',
    surface:    '#f8f9fa',
    text:       '#212529',
  },
  spacing: {
    unit: 8,      // base unit in px — multiply to get larger spacing
  },
  typography: {
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize:   16,
    lineHeight: 1.5,
    fontWeight: 400,
  },
}
```

### Using theme tokens in `css()`

Pass a function to `css()` that receives `{ theme }`:

```ts
import { css } from 'taikocss'

const heading = css(({ theme }) => ({
  color:       theme.colors.primary,
  fontFamily:  theme.typography.fontFamily,
  fontSize:    theme.spacing.unit * 4,      // 8 * 4 = 32 → "32px"
  lineHeight:  theme.typography.lineHeight,
  marginBottom: theme.spacing.unit * 2,     // 8 * 2 = 16 → "16px"
}))

const card = css(({ theme }) => ({
  backgroundColor: theme.colors.surface,
  borderRadius:    theme.spacing.unit,
  padding:         theme.spacing.unit * 3,
  '&:hover': {
    backgroundColor: theme.colors.background,
  },
}))
```

Everything is evaluated at build time. The browser sees `"cls_a3f9b2c1"` — not the function, not the theme object.

**Supported expressions inside the theme function:**

| Expression | Example | Result |
|---|---|---|
| String token | `theme.colors.primary` | `"tomato"` |
| Number token | `theme.spacing.unit` | `8` |
| Multiply | `theme.spacing.unit * 4` | `32` → `32px` |
| Add / subtract | `theme.spacing.unit + 2` | `10` → `10px` |
| String concatenation | `theme.colors.primary + ' !important'` | `"tomato !important"` |
| Template literal | `` `${theme.typography.fontFamily}` `` | `"Inter, system-ui, sans-serif"` |

**Not supported (build error):**

```ts
// ✗ Computed member access
css(({ theme }) => ({ color: theme.colors[dynamicKey] }))

// ✗ Conditional expressions
css(({ theme }) => ({ color: isDark ? theme.colors.text : theme.colors.muted }))

// ✗ Theme key that doesn't exist
css(({ theme }) => ({ color: theme.colors.doesNotExist }))
```

### Multiple themes and colour schemes

For light/dark mode and named branded colour schemes, add `colorSchemes` to your theme:

```ts
// src/theme.ts
export const myTheme: Theme = {
  // ...base tokens above...

  colorSchemes: {
    // A branded colour scheme with light and dark variants
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
          foreground: '#ffffff',
        },
      },
    },

    // Another scheme
    oceanBlue: {
      light: {
        colors: {
          background: '#e8f4f8',
          foreground: '#0d2d3d',
        },
      },
      dark: {
        colors: {
          background: '#0d2d3d',
          foreground: '#e8f4f8',
        },
      },
    },
  },
}
```

The plugin emits CSS custom properties for each scheme variant, scoped to `data-` attribute selectors. No JavaScript is required to switch themes — just update the attributes on your root element:

```html
<!-- Light mode, obnoxiousBrown scheme -->
<html data-color-scheme="obnoxiousBrown" data-mode="light">

<!-- Dark mode, obnoxiousBrown scheme -->
<html data-color-scheme="obnoxiousBrown" data-mode="dark">
```

The generated CSS looks like:

```css
[data-color-scheme="obnoxiousBrown"][data-mode="light"] {
  --colors-background: #f9f9f9;
  --colors-foreground: #121212;
}

[data-color-scheme="obnoxiousBrown"][data-mode="dark"] {
  --colors-background: #212121;
  --colors-foreground: #fff;
}
```

Switching schemes at runtime with JavaScript:

```ts
function setColorScheme(scheme: string, mode: 'light' | 'dark') {
  document.documentElement.dataset.colorScheme = scheme
  document.documentElement.dataset.mode = mode
}

// Switch to dark mode
setColorScheme('obnoxiousBrown', 'dark')
```

---

## Global styles

Use `globalCss` to inject page-level CSS — resets, base typography, font-face declarations, or anything that needs to apply globally rather than to a specific class.

```ts
// src/globals.ts
import { globalCss } from 'taikocss'

globalCss`
  *, *::before, *::after {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    padding: 0;
    font-family: Inter, system-ui, sans-serif;
    line-height: 1.5;
    color: #212529;
    background-color: #ffffff;
  }

  img, video {
    max-width: 100%;
    display: block;
  }

  h1, h2, h3, h4, h5, h6 {
    margin-top: 0;
    margin-bottom: 0.5rem;
    font-weight: 700;
    line-height: 1.2;
  }
`
```

Import the file once at your application root:

```ts
// src/main.tsx
import './globals'    // ← triggers the global CSS injection
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
```

**Theme tokens can be interpolated** as long as they are statically resolvable:

```ts
import { globalCss } from 'taikocss'
import { myTheme } from './theme'

globalCss`
  :root {
    --font-family: ${myTheme.typography.fontFamily};
    --color-primary: ${myTheme.colors.primary};
  }

  body {
    font-family: var(--font-family);
  }
`
```

`globalCss` processes its template through the same LightningCSS pipeline as `css()` — the output is minified, vendor-prefixed, and syntax-lowered for your browser targets.

---

## Keyframes

Use `keyframes` to define `@keyframes` animations at build time. The return value is the hashed animation name string, which you can use anywhere an animation name is expected.

```ts
import { keyframes, css } from 'taikocss'

const fadeIn = keyframes`
  from { opacity: 0; }
  to   { opacity: 1; }
`

const slideUp = keyframes`
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
`

const pulse = keyframes`
  0%, 100% { transform: scale(1); }
  50%       { transform: scale(1.05); }
`
```

Use the animation name in a `css()` call or a `style` prop:

```tsx
// In a css() call — keyframes must be declared before css() in the same file
const modal = css({
  animation: `${fadeIn} 200ms ease-out`,
})

const card = css({
  animation: `${slideUp} 300ms cubic-bezier(0.16, 1, 0.3, 1)`,
})

// In a style prop
function Spinner() {
  return (
    <div style={{ animation: `${pulse} 1.5s ease-in-out infinite` }}>
      Loading…
    </div>
  )
}
```

At build time, `fadeIn` becomes `"kf_a3f9b2c1"` — a stable, content-hashed animation name. Two identical `keyframes` bodies in different files produce the same name and a single CSS `@keyframes` declaration.

**Ordering rule:** `keyframes` declarations must appear before any `css()` call that references them within the same file.

---

## Container queries

### Querying a container

`@container` rules work exactly like `@media` rules — use them as nested object keys inside `css()`:

```ts
import { css } from 'taikocss'

const articleBody = css({
  fontSize: '1rem',

  // Responds to the viewport (standard media query)
  '@media (min-width: 768px)': {
    fontSize: '1.125rem',
  },

  // Responds to the nearest containment ancestor
  '@container (min-width: 600px)': {
    fontSize: '1.25rem',
    columnCount: 2,
  },

  // Responds to a named container
  '@container sidebar (max-width: 240px)': {
    display: 'none',
  },
})
```

### Declaring a containment context

Use the `container()` helper inside a `css()` call to declare a named containment context. It expands at build time — no runtime overhead.

```ts
import { css, container } from 'taikocss'

// Unnamed containment context (any @container query can match)
const wrapper = css({
  ...container('inline-size'),
  width: '100%',
})

// Named containment context (only @container sidebar … queries match)
const sidebarEl = css({
  ...container('sidebar', 'inline-size'),
  width: '280px',
  flexShrink: 0,
})

// Then in child components, query the named container:
const navItem = css({
  padding: '8px 16px',

  '@container sidebar (max-width: 200px)': {
    padding: '4px 8px',
    fontSize: '0.875rem',
  },
})
```

`container(type)` and `container(name, type)` expand to the appropriate `container-type` and `container-name` CSS declarations. Available types: `'size'`, `'inline-size'`, `'block-size'`, `'normal'`.

---

## Media queries

Standard `@media` rules have been supported since v1. A quick reference:

```ts
const layout = css({
  display: 'block',
  padding: 16,

  '@media (min-width: 640px)': {
    display: 'flex',
    gap: 24,
  },

  '@media (min-width: 1024px)': {
    maxWidth: 1200,
    margin: '0 auto',
  },

  '@media (prefers-color-scheme: dark)': {
    backgroundColor: '#1a1a1a',
    color: '#f0f0f0',
  },

  '@media (prefers-reduced-motion: reduce)': {
    animation: 'none',
    transition: 'none',
  },
})
```

---

## RTL / bidirectional support

When your application serves both LTR and RTL locales, set `generateForBothDir: true` in the plugin options. The engine will emit two CSS modules for every rule — one for each direction — and inject both imports into the transformed JS. The active direction is determined by the `dir` attribute on `<html>` or any ancestor element — no JavaScript switching code is needed.

```ts
// vite.config.ts
pigment({
  theme: myTheme,
  css: {
    defaultDirection: 'ltr',
    generateForBothDir: true,
  },
})
```

Write your styles using CSS logical properties for best results:

```ts
const panel = css({
  marginInlineStart: 16,    // left in LTR, right in RTL
  paddingInline: 24,
  borderInlineStart: '3px solid tomato',
})
```

---

## Runtime shim (for Jest / Vitest / ts-node)

When running tests or scripts that don't go through the Vite transform, `css()` calls need to return something without crashing. The package includes a no-op shim for this purpose.

Create `src/css.ts` in your project:

```ts
// src/css.ts
// No-op shim for untransformed environments (Jest, Vitest node mode, ts-node).
// The Vite plugin replaces all css() calls with static class name strings
// before this code ever runs in a real browser.
export function css(_styles: Record<string, unknown>): string {
  return ''
}
```

Import from your own shim file in components:

```ts
import { css } from '../css'   // → the shim in tests, replaced by the engine in builds
```

---

## TypeScript

The package ships full TypeScript declarations. No `@types` package is needed.

```ts
import type { Theme, CSSProperties } from 'taikocss'

// Theme is fully typed — autocomplete works for all token paths
const myTheme: Theme = {
  colors: { primary: 'tomato' },
  spacing: { unit: 8 },
}

// CSSProperties maps over CSSStyleDeclaration — IDE autocomplete for all properties
const styles: CSSProperties = {
  backgroundColor: 'tomato',
  '&:hover': { backgroundColor: 'darkred' },
}
```

---

## Testing

### Unit tests — Vitest (recommended)

Configure Vitest to use the Vite plugin so that `css()` calls are transformed before your component tests run:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { pigment } from 'taikocss/vite'
import { myTheme } from './src/theme'

export default defineConfig({
  plugins: [pigment({ theme: myTheme })],
  test: {
    environment: 'jsdom',
  },
})
```

Write tests as normal — the class name returned by `css()` is stable and content-hashed, so you can assert on it:

```ts
// Button.test.ts
import { render } from '@testing-library/react'
import { Button } from './Button'

test('applies the correct class name', () => {
  const { container } = render(<Button>Click me</Button>)
  const btn = container.querySelector('button')!

  // Class names are stable — same input always produces the same hash
  expect(btn.className).toMatch(/^cls_[a-f0-9]{8}$/)
})

test('class name is consistent between test runs', () => {
  const { container: c1 } = render(<Button>A</Button>)
  const { container: c2 } = render(<Button>B</Button>)

  // Same component = same styles = same hash
  expect(c1.querySelector('button')!.className)
    .toBe(c2.querySelector('button')!.className)
})
```

### Unit tests — Jest

In Jest, the Vite transform does not run. Add a module name mapper to redirect `css()` imports to the no-op shim:

```js
// jest.config.js
module.exports = {
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    // Redirect the engine's css import to the no-op shim
    '^taikocss$': '<rootDir>/src/css.ts',
  },
}
```

Components will render without styles — class names will be `""` — but the components themselves won't crash. This is the right behaviour for logic-focused unit tests.

### Testing the transform directly

You can call the native `transform()` function directly in tests to assert on the CSS output:

```ts
// transform.test.ts
import { transform } from 'taikocss'

test('extracts a css() call', () => {
  const { code, cssRules } = transform(
    'test.tsx',
    `const btn = css({ color: 'red', padding: 8 })`
  )

  // JS: the call is replaced with a class name string
  expect(code).toMatch(/"cls_[a-f0-9]{8}"/)
  expect(code).not.toContain('css({')

  // CSS: correct declarations, minified
  expect(cssRules).toHaveLength(1)
  expect(cssRules[0].css).toContain('color:red')
  expect(cssRules[0].css).toContain('padding:8px')

  // Hash is stable
  expect(cssRules[0].hash).toHaveLength(8)
})

test('resolves theme tokens', () => {
  const themeJson = JSON.stringify({
    colors: { primary: 'tomato' },
    spacing: { unit: 8 },
  })

  const { cssRules } = transform(
    'test.tsx',
    `const btn = css(({ theme }) => ({ color: theme.colors.primary, padding: theme.spacing.unit * 2 }))`,
    themeJson
  )

  expect(cssRules[0].css).toContain('color:tomato')
  expect(cssRules[0].css).toContain('padding:16px')
})

test('throws a rich error for dynamic values', () => {
  expect(() =>
    transform('src/Comp.tsx', `const x = css({ color: someVar })`)
  ).toThrow(/src\/Comp\.tsx:\d+:\d+/)
})

test('keyframes produces a hashed name', () => {
  const { code, keyframes } = transform(
    'test.tsx',
    'const fadeIn = keyframes`from { opacity: 0 } to { opacity: 1 }`'
  )

  expect(code).toMatch(/"kf_[a-f0-9]{8}"/)
  expect(keyframes).toHaveLength(1)
  expect(keyframes[0].css).toContain('@keyframes')
})

test('globalCss emits a global rule', () => {
  const { globalCss } = transform(
    'test.tsx',
    'globalCss`body { margin: 0 }`'
  )

  expect(globalCss).toHaveLength(1)
  expect(globalCss[0].css).toContain('body')
  expect(globalCss[0].css).toContain('margin:0')
})
```

### Running the test suite

```bash
# Run the built-in test suite (tests the native Rust binary directly)
node test.mjs

# With Vitest
npx vitest run

# With Jest
npx jest
```

---

## Build

```bash
# Production build (optimised native binary)
npm run build

# Debug build (faster compile, includes debug symbols)
npm run build:debug
```

---

## How class names are generated

Class names follow the pattern `cls_<hash>` where `<hash>` is an 8-character FNV-1a hex digest of the raw CSS content (before minification). This means:

- **Same input → same output.** Two components that define the exact same styles will share a class name and a single CSS declaration in the bundle.
- **Content-addressed, not filename-addressed.** Renaming or moving a file does not change existing class names. Refactors don't break cached CSS.
- **No collisions in practice.** FNV-1a over the full CSS string; the probability of an 8-hex-digit collision across a typical component library is negligible.

Keyframe animation names follow `kf_<hash>` by the same rule.

---

## Source maps

Both the transformed JS and the extracted CSS ship with V3 source maps in development mode. Browser DevTools will show the original `css({})` call site when you inspect a styled element, and clicking a CSS rule in the Styles panel will jump to the correct line in your source file.

Source maps are inlined as base64 data URIs in the virtual CSS modules — no `.map` files on disk.

---

## Browser support

LightningCSS targets Chrome 105+, Safari 16+, and Firefox 110+ by default. Features not natively supported by these targets (e.g. older syntax) are automatically lowered or vendor-prefixed. To adjust targets, open a GitHub issue — configurable targets are on the roadmap.

---

## Limitations

- All `css()`, `globalCss`, `keyframes`, and `container()` arguments must be **statically resolvable at build time**. Runtime variables, imports from other modules, and conditional expressions are not supported and will produce a build error with a precise file/line/column message.
- The `css()` function argument form (`css(({ theme }) => …)`) currently supports member access and the four arithmetic operators. Template literals with complex expressions are not supported.
- Spread properties (`...obj`) inside `css()` objects are not supported, except for the `container()` helper which is specially handled.
- Server-side rendering without Vite (e.g. Next.js, Remix) is not yet supported. The runtime shim will keep components from crashing but styles will not be injected.

---

## License

MIT