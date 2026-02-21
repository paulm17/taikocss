import { createRequire } from 'module'

const require = createRequire(import.meta.url)

/**
 * Load the native binary.
 * 1. Local build first (repo contributors / debug builds).
 * 2. Platform-specific npm package (installed consumers).
 * 3. Descriptive error if neither is available.
 */
function loadNative() {
  // 1. Local build — use loader.cjs which loads the .node binary directly,
  //    bypassing index.js (which is CJS but treated as ESM by Node when
  //    package.json has "type":"module").
  try {
    return require('./loader.cjs')
  } catch {}

  // 2. Platform-specific optional package (installed consumers)
  const platform = `${process.platform}-${process.arch}`
  try {
    return require(`@taikocss/core-${platform}`)
  } catch (e) {
    throw new Error(
      `taikocss: no prebuilt binary found for ${platform}.\n` +
      `If you are on a supported platform, try reinstalling.\n` +
      `Supported platforms: darwin-arm64, darwin-x64, linux-x64-gnu, ` +
      `linux-arm64-gnu, win32-x64-msvc.\n` +
      `Original error: ${e.message}`
    )
  }
}

const { transform } = loadNative()

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Maps virtual module ID → { css, map } */
const cssMap = new Map()

/** Maps source file path → Set<virtualModuleId> for targeted HMR invalidation */
const fileToVids = new Map()

// ---------------------------------------------------------------------------
// Colour scheme CSS variable emission
// ---------------------------------------------------------------------------

function buildColorSchemeCSS(schemeName, variants) {
  const modules = []
  for (const [mode, tokens] of Object.entries(variants)) {
    if (!tokens) continue
    const lines = []
    for (const [group, values] of Object.entries(tokens)) {
      for (const [key, value] of Object.entries(values)) {
        lines.push(`  --${group}-${key}: ${value};`)
      }
    }
    const css = `[data-color-scheme="${schemeName}"][data-mode="${mode}"] {\n${lines.join('\n')}\n}`
    const vid = `virtual:taikocss/theme-${schemeName}-${mode}.css`
    modules.push({ vid, css })
  }
  return modules
}

// ---------------------------------------------------------------------------
// pigment(options) — the main plugin factory
// ---------------------------------------------------------------------------

/**
 * Create the zero-runtime CSS Vite plugin.
 *
 * @param {import('./plugin.d.ts').PigmentOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function pigment(options = {}) {
  const theme = options.theme ?? null
  const themeJson = theme ? JSON.stringify(theme) : null
  const dir = options.css?.defaultDirection ?? 'ltr'

  return {
    name: 'taikocss',
    enforce: 'pre',

    // Emit colour scheme virtual modules at startup
    buildStart() {
      if (!theme?.colorSchemes) return
      for (const [schemeName, variants] of Object.entries(theme.colorSchemes)) {
        for (const { vid, css } of buildColorSchemeCSS(schemeName, variants)) {
          cssMap.set(vid, { css, map: null })
        }
      }
    },

    transform(code, id) {
      if (!/\.(t|j)sx?$/.test(id) || id.includes('node_modules')) return
      if (
        !code.includes('css(') &&
        !code.includes('globalCss`') &&
        !code.includes('keyframes`')
      ) return

      let result
      try {
        result = transform(id, code, themeJson, dir)
      } catch (err) {
        this.error(err.message)
      }

      const hasWork =
        result.cssRules.length > 0 ||
        (result.globalCss?.length ?? 0) > 0 ||
        (result.keyframes?.length ?? 0) > 0

      if (!hasWork) return

      let imports = ''

      // Global CSS first (spec §2.5)
      for (const rule of result.globalCss ?? []) {
        const vid = `virtual:taikocss/global-${rule.hash}.css`
        if (!cssMap.has(vid)) {
          cssMap.set(vid, { css: rule.css, map: rule.map ?? null })
          imports += `import "${vid}";\n`
        }
        if (!fileToVids.has(id)) fileToVids.set(id, new Set())
        fileToVids.get(id).add(vid)
      }

      // Keyframes
      for (const kf of result.keyframes ?? []) {
        const vid = `virtual:taikocss/kf-${kf.hash}.css`
        if (!cssMap.has(vid)) {
          cssMap.set(vid, { css: kf.css, map: kf.map ?? null })
          imports += `import "${vid}";\n`
        }
        if (!fileToVids.has(id)) fileToVids.set(id, new Set())
        fileToVids.get(id).add(vid)
      }

      // Component CSS rules
      for (const rule of result.cssRules) {
        const vid = `virtual:taikocss/${rule.hash}.css`
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
      if (id.startsWith('virtual:taikocss/')) return id
    },

    load(id) {
      if (!id.startsWith('virtual:taikocss/')) return
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

/**
 * @deprecated Use pigment() instead.
 */
export const rustCssPlugin = pigment()