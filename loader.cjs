// loader.cjs
// Loads the native .node binary directly, bypassing index.js.
//
// Why: package.json sets "type":"module", so Node parses all .js files as ESM
// — including the NAPI-RS generated index.js which is pure CJS and uses
// require(). Even calling it through createRequire() fails because Node's
// module-type decision is based on the nearest package.json, not the caller.
//
// The .node binary itself has no module-type ambiguity: require() on a .node
// file always works from a CJS context. So we detect the right binary name
// for the current platform and load it directly.
'use strict'

const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const dir = __dirname

function findNodeFile() {
  const { platform, arch } = process

  // Build the most-likely filename for this platform+arch first
  const preferred =
    platform === 'darwin' ? `taikocss.darwin-${arch}.node` :
    platform === 'win32'  ? `taikocss.win32-${arch}-msvc.node` :
                            `taikocss.linux-${arch}-gnu.node`

  if (existsSync(join(dir, preferred))) return join(dir, preferred)

  // macOS universal binary fallback
  if (platform === 'darwin') {
    const universal = join(dir, 'taikocss.darwin-universal.node')
    if (existsSync(universal)) return universal
  }

  // Last resort: any taikocss*.node in the directory
  const found = readdirSync(dir).find(f => f.startsWith('taikocss') && f.endsWith('.node'))
  if (found) return join(dir, found)

  return null
}

const nodePath = findNodeFile()

if (!nodePath) {
  throw new Error(
    `taikocss: could not find a compiled .node binary in ${dir}.\n` +
    `Run \`npm run build\` (requires Rust: https://rustup.rs) to build one.`
  )
}

module.exports = require(nodePath)
