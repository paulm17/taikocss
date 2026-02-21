import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { transform } = require('./index.js') // loads .node binary

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

// Maps virtual module ID → { css, map }
const cssMap = new Map()

// Maps source file path → Set<virtualModuleId> for targeted HMR invalidation
const fileToVids = new Map()

// ---------------------------------------------------------------------------
// Colour scheme CSS variable emission
//
// Converts a colourScheme entry like:
//   { obnoxiousBrown: { light: { colors: { bg: '#fff' } }, dark: { colors: { bg: '#000' } } } }
// into virtual CSS modules containing [data-color-scheme][data-mode] blocks.
// ---------------------------------------------------------------------------

function buildColorSchemeCSS(schemeName, variants) {
  const modules = []
  for (const [mode, tokens] of Object.entries(variants)) {
    if (!tokens) continue
    const lines = []
    for (const [group, values] of Object.entries(tokens)) {
      for (const [key, value] of Object.entries(values)) {
        // e.g. colors.background → --colors-background: #f9f9f9
        lines.push(`  --${group}-${key}: ${value};`)
      }
    }
    const css = `[data-color-scheme="${schemeName}"][data-mode="${mode}"] {\n${lines.join('\n')}\n}`
    const vid = `virtual:css/theme-${schemeName}-${mode}.css`
    modules.push({ vid, css })
  }
  return modules
}

// ---------------------------------------------------------------------------
// pigment(options) — the main plugin factory (v3)
// ---------------------------------------------------------------------------

export function pigment(options = {}) {
  const theme = options.theme ?? null
  const themeJson = theme ? JSON.stringify(theme) : null
  const dir = options.css?.dir ?? 'ltr'

  return {
    name: 'rust-css',
    enforce: 'pre',

    // ── Startup: emit colour scheme virtual modules ─────────────────────
    buildStart() {
      if (!theme?.colorSchemes) return
      for (const [schemeName, variants] of Object.entries(theme.colorSchemes)) {
        for (const { vid, css } of buildColorSchemeCSS(schemeName, variants)) {
          cssMap.set(vid, { css, map: null })
        }
      }
    },

    // ── Transform each JS/TS/JSX/TSX file ──────────────────────────────
    transform(code, id) {
      if (!/\.(t|j)sx?$/.test(id) || id.includes('node_modules')) return
      // Quick bail if there's no recognisable call
      if (!code.includes('css(') && !code.includes('css`') && !code.includes('globalCss`') && !code.includes('keyframes`')) return

      let result
      try {
        result = transform(id, code, themeJson, dir)
      } catch (err) {
        this.error(err.message)
      }

      const hasWork =
        result.cssRules.length > 0 ||
        result.globalCss.length > 0 ||
        result.keyframes.length > 0

      if (!hasWork) return

      // Global CSS imports come first (spec §2.5)
      let imports = ''

      for (const rule of result.globalCss) {
        const vid = `virtual:css/global-${rule.hash}.css`
        if (!cssMap.has(vid)) {
          cssMap.set(vid, { css: rule.css, map: rule.map ?? null })
          imports += `import "${vid}";\n`
        }
        if (!fileToVids.has(id)) fileToVids.set(id, new Set())
        fileToVids.get(id).add(vid)
      }

      for (const rule of result.keyframes) {
        const vid = `virtual:css/kf-${rule.hash}.css`
        if (!cssMap.has(vid)) {
          cssMap.set(vid, { css: rule.css, map: rule.map ?? null })
          imports += `import "${vid}";\n`
        }
        if (!fileToVids.has(id)) fileToVids.set(id, new Set())
        fileToVids.get(id).add(vid)
      }

      for (const rule of result.cssRules) {
        const vid = `virtual:css/${rule.hash}.css`
        if (!cssMap.has(vid)) {
          cssMap.set(vid, { css: rule.css, map: rule.map ?? null })
          imports += `import "${vid}";\n`
        }
        if (!fileToVids.has(id)) fileToVids.set(id, new Set())
        fileToVids.get(id).add(vid)
      }

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

      if (entry.map) {
        const b64 = Buffer.from(entry.map).toString('base64')
        return (
          entry.css +
          `\n/*# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64} */`
        )
      }
      return entry.css
    },

    // ── HMR ──────────────────────────────────────────────────────────────
    handleHotUpdate({ file, server }) {
      const vids = fileToVids.get(file)
      if (!vids || vids.size === 0) return

      const affectedMods = []
      for (const vid of vids) {
        cssMap.delete(vid)
        const mod = server.moduleGraph.getModuleById(vid)
        if (mod) affectedMods.push(mod)
      }
      fileToVids.delete(file)

      if (affectedMods.length === 0) return
      for (const mod of affectedMods) server.moduleGraph.invalidateModule(mod)
      return affectedMods
    },
  }
}

// ---------------------------------------------------------------------------
// Backwards-compatible bare plugin export (deprecated in v3)
// ---------------------------------------------------------------------------

export const rustCssPlugin = pigment()

export default {
  plugins: [pigment()],
}