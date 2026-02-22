// scripts/build-shim.js
// Compiles src/css.ts and src/runtime.ts → .js (ESM) via tsc,
// then copies each to .cjs for CommonJS consumers.
// Both files are identical in content — the exports map handles resolution.
import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

console.log('tsc: compiling src/*.ts...')
execFileSync('npx', ['tsc'], { cwd: root, stdio: 'inherit', shell: true })

// css shim
const cssSrc = join(root, 'src', 'css.js')
const cssCjs = join(root, 'src', 'css.cjs')
copyFileSync(cssSrc, cssCjs)
console.log('build-shim: wrote src/css.js and src/css.cjs')

// runtime module
const rtSrc = join(root, 'src', 'runtime.js')
const rtCjs = join(root, 'src', 'runtime.cjs')
copyFileSync(rtSrc, rtCjs)
console.log('build-shim: wrote src/runtime.js and src/runtime.cjs')