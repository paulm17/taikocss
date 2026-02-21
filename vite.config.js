import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { transform } = require('./my-css-engine/index.js') // loads .node binary

// Maps virtual module ID → { css, map } so both the CSS content and its
// source map are available when Vite calls load().
const cssMap = new Map()

// Maps source file path → Set<virtualModuleId> it produced.
// Lets handleHotUpdate invalidate only the virtual modules belonging to the
// file that actually changed, rather than blowing away everything.
const fileToVids = new Map()

export const rustCssPlugin = {
  name: 'rust-css',
  enforce: 'pre',

  transform(code, id) {
    if (!/\.(t|j)sx?$/.test(id) || id.includes('node_modules')) return
    if (!code.includes('css(')) return

    let result
    try {
      result = transform(id, code)
    } catch (err) {
      // The Rust core already embeds "file:line:col: css() — …" in the message.
      // this.error() surfaces it in the Vite browser overlay and terminal.
      this.error(err.message)
    }

    if (!result.cssRules.length) return

    let imports = ''
    for (const rule of result.cssRules) {
      const vid = `virtual:css/${rule.hash}.css`
      if (!cssMap.has(vid)) {          // deduplicate — only import each hash once
        cssMap.set(vid, { css: rule.css, map: rule.map ?? null })
        imports += `import "${vid}";\n`
      }
      // Track which virtual modules this source file owns so HMR can
      // invalidate precisely.
      if (!fileToVids.has(id)) fileToVids.set(id, new Set())
      fileToVids.get(id).add(vid)
    }

    // Pass the JS source map produced by oxc_codegen back to Vite.
    // Vite will chain it with any upstream maps (e.g. the TypeScript map).
    return {
      code: imports + result.code,
      map: result.map ?? null,
    }
  },

  resolveId(id) {
    if (id.startsWith('virtual:css/')) return id
  },

  load(id) {
    if (!id.startsWith('virtual:css/')) return
    const entry = cssMap.get(id)
    if (!entry) return

    // Inline the CSS source map as a data URI comment so DevTools can map
    // minified selectors back to the original object literal in the JS file.
    if (entry.map) {
      const b64 = Buffer.from(entry.map).toString('base64')
      return (
        entry.css +
        `\n/*# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64} */`
      )
    }
    return entry.css
  },

  // ── HMR ────────────────────────────────────────────────────────────────────
  //
  // When a source file is saved in dev mode, Vite calls handleHotUpdate for
  // that file.  We need to:
  //
  //  1. Drop the stale virtual CSS module entries for this file from cssMap
  //     so the next transform() call re-populates them with fresh content.
  //  2. Find the corresponding ModuleNode objects in Vite's module graph and
  //     return them — Vite will then invalidate those modules and push an
  //     update to the browser.
  //
  // Because the virtual CSS modules are real module-graph nodes (Vite
  // resolved them via resolveId), the browser receives a targeted CSS update
  // rather than a full page reload in most cases.
  handleHotUpdate({ file, server }) {
    const vids = fileToVids.get(file)
    if (!vids || vids.size === 0) return

    const affectedMods = []

    for (const vid of vids) {
      // Evict the stale CSS so load() will serve fresh content on next hit.
      cssMap.delete(vid)

      const mod = server.moduleGraph.getModuleById(vid)
      if (mod) affectedMods.push(mod)
    }

    // Clear the file → vids mapping; it will be rebuilt by transform().
    fileToVids.delete(file)

    if (affectedMods.length === 0) return

    // Invalidate each virtual module so Vite re-fetches it.
    for (const mod of affectedMods) {
      server.moduleGraph.invalidateModule(mod)
    }

    // Return the affected modules to Vite.  Vite will send targeted
    // 'css-update' messages to the browser HMR client for each one,
    // avoiding a full page reload.
    return affectedMods
  }
}

export default {
  plugins: [rustCssPlugin]
}