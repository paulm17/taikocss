// scripts/build-shim.js
// Compiles src/css.ts → src/css.js (ESM) via tsc, then copies it to
// src/css.cjs for CommonJS consumers.
// Both files are identical in content — the exports map handles resolution.
import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

console.log('tsc: compiling src/css.ts...')
execFileSync('npx', ['tsc'], { cwd: root, stdio: 'inherit', shell: true })

const src = join(root, 'src', 'css.js')
const cjs = join(root, 'src', 'css.cjs')
copyFileSync(src, cjs)
console.log('build-shim: wrote src/css.js and src/css.cjs')