import { createRequire } from 'module'

const require = createRequire(import.meta.url)

function loadNative() {
  try { return require('./loader.cjs') } catch { }
  const platform = `${process.platform}-${process.arch}`
  try { return require(`@taikocss/core-${platform}`) } catch (e) {
    throw new Error(`taikocss: no prebuilt binary found for ${platform}.`)
  }
}

const { transform } = loadNative()

// Store the actual CSS contents
const cssMap = new Map()
// Store a version counter to bust the browser cache safely
const cssVersions = new Map()

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

export function taiko(options = {}) {
  const theme = options.theme ?? null
  const themeJson = theme ? JSON.stringify(theme) : null
  const dir = options.css?.defaultDirection ?? 'ltr'

  return {
    name: 'taikocss',
    enforce: 'pre',

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
      if (!code.includes('css(') && !code.includes('globalCss`') && !code.includes('keyframes`')) return

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

      const processRule = (rule, prefix) => {
        const vid = prefix ? `virtual:taikocss/${prefix}-${rule.hash}.css` : `virtual:taikocss/${rule.hash}.css`;
        const existing = cssMap.get(vid);

        let version = cssVersions.get(vid) || 0;

        // If the Rust compiler gave us brand new or updated CSS
        if (!existing || existing.css !== rule.css) {
          version++; // Bump the cache-buster
          cssVersions.set(vid, version);
          cssMap.set(vid, { css: rule.css, map: rule.map ?? null });
        }

        // Append the ?v= version counter. This guarantees the browser fetches the new styles!
        imports += `import "${vid}?v=${version}";\n`;
      };

      for (const rule of result.globalCss ?? []) processRule(rule, 'global');
      for (const kf of result.keyframes ?? []) processRule(kf, 'kf');
      for (const rule of result.cssRules) processRule(rule, '');

      return {
        code: imports + result.code,
        map: result.map ?? null,
      }
    },

    resolveId(id) {
      // Intercept the ID with OR without the query parameter
      if (id.startsWith('virtual:taikocss/')) {
        return '\0' + id;
      }
    },

    load(id) {
      if (id.startsWith('\0virtual:taikocss/')) {
        // Strip the \0 and the ?v= query parameter to lookup the base filename
        const cleanId = id.slice(1).split('?')[0];
        const entry = cssMap.get(cleanId);
        if (!entry) return;

        if (entry.map) {
          const b64 = Buffer.from(entry.map).toString('base64');
          return entry.css + `\n/*# sourceMappingURL=data:application/json;charset=utf-8;base64,${b64} */`;
        }
        return entry.css;
      }
    },

    handleHotUpdate({ file, server }) {
      if (!/\.(t|j)sx?$/.test(file) || file.includes('node_modules')) return;

      // Find all virtual CSS modules that might be affected and invalidate them
      const affectedModules = [];
      for (const [vid] of cssMap) {
        const resolved = '\0' + vid;
        const mod = server.moduleGraph.getModuleById(resolved);
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
          affectedModules.push(mod);
        }
      }
      return affectedModules.length > 0 ? affectedModules : undefined;
    }
  }
}

export const rustCssPlugin = taiko()