# Zero-Runtime CSS Engine: Taikocss — Next Steps

Current state: the Rust core builds cleanly, all 12 tests pass, and the Vite
plugin wires correctly into the build pipeline. This document specifies the
next phases of work.

---

## 1. Runtime Shim

**Problem:** The engine erases `css({})` calls at build time, but tools that
bypass the Vite transform (Jest, Vitest in node mode, plain `ts-node` scripts,
Storybook without the plugin) will try to call the real `css` function at
runtime and crash because it doesn't exist.

**Spec:**

Create `src/css.ts` — a no-op shim that returns the object identity so
components render without styles in untransformed environments:

```ts
// src/css.ts
// At runtime this is a no-op. The Vite plugin replaces all calls with a
// static class name string at build time, so this code only runs in
// environments that don't go through the plugin (tests, SSR without transform).
export function css(_styles: Record<string, unknown>): string {
  return ''
}
```

The import in user code stays exactly as it is:

```ts
import { css } from './css'
```

No changes to the Rust core are needed — the plugin already strips the import.

---

## 2. Source Maps

**Problem:** When a build error or browser DevTools points at minified CSS or
transformed JS, there is no way to trace it back to the original source
location.

**Spec:**

### 2a — CSS source maps

LightningCSS already supports source maps via `PrinterOptions`. Thread them
through:

```rust
let printer_options = PrinterOptions {
    minify: true,
    targets,
    source_map: Some(SourceMapOptions::default()),
    ..PrinterOptions::default()
};

let result = stylesheet.to_css(printer_options)?;
let map = result.map; // Option<String> — inline or external
```

Attach the map as a `/*# sourceMappingURL=... */` comment in the virtual CSS
module, or expose it as a separate `result.css_map` field in `TransformResult`.

### 2b — JS source maps

The current text-replacement approach destroys the original JS source map.
Two options, in order of preference:

**Option A (preferred):** Use `oxc_codegen`'s built-in source map support.
Switch from byte-range text replacement to proper AST mutation + codegen, and
pass `CodegenOptions { source_map: true, .. }`. This produces a correct V3
source map for the transformed JS.

**Option B (quick fix):** After text replacement, call `magic-string` from the
JS shim to produce an approximate source map. Lower fidelity but zero Rust
changes.

**`TransformResult` additions:**

```rust
pub struct TransformResult {
    pub code: String,
    pub css_rules: Vec<ExtractedCssRule>,
    pub map: Option<String>,  // JS source map JSON, if generated
}

pub struct ExtractedCssRule {
    pub hash: String,
    pub css: String,
    pub map: Option<String>,  // CSS source map JSON, if generated
}
```

---

## 3. TypeScript Types for the JS API

**Problem:** The generated `index.d.ts` from NAPI-RS is correct but bare.
Users of the Vite plugin get no type safety when calling `css()`.

**Spec:**

Add a `types/` directory with hand-written ambient declarations:

```ts
// types/css.d.ts

type CSSValue = string | number

type CSSProperties = {
  [Property in keyof CSSStyleDeclaration]?: CSSValue
} & {
  // Pseudo-selectors and at-rules via string index
  [key: string]: CSSValue | CSSProperties
}

/**
 * Define a CSS class from a static object. Replaced at build time by a
 * hashed class name string. The object must contain only static values —
 * no runtime variables.
 *
 * @example
 * const button = css({ backgroundColor: 'blue', padding: '8px 16px' })
 * // At build time: const button = "cls_a3f9b2c1"
 */
export declare function css(styles: CSSProperties): string
```

Add to `package.json`:
```json
"exports": {
  ".": { "types": "./types/css.d.ts", "require": "./index.js" },
  "./vite": { "types": "./types/vite.d.ts", "default": "./vite.config.js" }
}
```

---

## 4. Error Reporting

**Problem:** When a `css()` call contains a dynamic value, the engine currently
throws a generic Rust error. The developer sees a stack trace with no
indication of which file or line caused the problem.

**Spec:**

Pass the source file path and the OXC span into the error message:

```rust
// Current
return Err(Error::new(
    Status::InvalidArg,
    format!("Only static values are supported (property: '{}')", key_str),
))

// Target
return Err(Error::new(
    Status::InvalidArg,
    format!(
        "{}:{}:{}: css() — only static values are supported (property: '{}')\n\
         Hint: extract the value to a constant or use a CSS variable.",
        filename, line, col, key_str
    ),
))
```

OXC spans carry byte offsets; convert to line/col using a simple scan of the
source string. The Vite plugin should re-throw with `vite.createError()` so
the error appears in the browser overlay.

---

## 5. Deduplication of Identical Rules

**Problem:** If two components define the same `css({})` object, the engine
emits two identical virtual CSS modules with the same hash. Vite deduplicates
virtual module IDs, so the CSS is only loaded once — but the Rust core does
redundant work and the JS shim emits duplicate `import` statements.

**Spec:**

In the Vite shim, track emitted hashes and skip re-importing known ones:

```js
// vite.config.js
const cssMap = new Map()   // hash → css string (already present)

// In transform():
for (const rule of result.cssRules) {
  const vid = `virtual:css/${rule.hash}.css`
  if (!cssMap.has(vid)) {          // ← only import once
    cssMap.set(vid, rule.css)
    imports += `import "${vid}";\n`
  }
}
```

No Rust changes needed. This is purely a shim-level optimisation.

---

## 6. HMR (Hot Module Replacement)

**Problem:** In Vite dev mode, editing a component that uses `css()` should
update styles in the browser without a full page reload.

**Spec:**

Vite's virtual module system handles most of this automatically — when the
`transform` hook returns new CSS, Vite invalidates the virtual module and
pushes the update. The one gap is that the virtual module has no `import.meta.hot`
boundary, so Vite may fall back to a full reload.

Add an `handleHotUpdate` hook to the plugin:

```js
handleHotUpdate({ file, server }) {
  // Invalidate all virtual CSS modules that originated from this file
  const mods = [...cssMap.keys()]
    .filter(id => id.startsWith(`virtual:css/`))
    .map(id => server.moduleGraph.getModuleById(id))
    .filter(Boolean)

  if (mods.length) {
    server.ws.send({ type: 'full-reload' }) // or targeted update
    return mods
  }
}
```

A more precise implementation would track which virtual module IDs were
produced by which source file, then invalidate only the affected ones.

---

## 7. Test Coverage Gaps

The current 12 tests cover the happy path well. Add tests for:

| Scenario | Expected behaviour |
|---|---|
| `css()` inside a function body | Extracted correctly |
| `css()` as a default export | Extracted correctly |
| Dynamic value (`color: myVar`) | Build error with file/line info |
| Spread in object (`...base`) | Build error |
| TSX file with type annotations | Extracted correctly, types stripped |
| Two files with identical objects | Same hash, CSS emitted once |
| Integer vs float numerics | `16` → `16px`, `1.5` → `1.5px` |
| Vendor-prefix properties | Passed through LightningCSS correctly |

---

## Priority Order

1. **Runtime shim** — unblocks Jest/Vitest usage, one file, trivial
2. **TypeScript types** — unblocks adoption, no Rust changes
3. **Error reporting** — improves DX significantly, small Rust change
4. **Deduplication** — two lines in the JS shim
5. **Source maps** — important for production, moderate Rust work
6. **HMR** — polish, Vite-side only
7. **Test coverage** — ongoing