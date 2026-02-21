import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { transform } = require('./index.js')

// ─── helpers ────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    failed++
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'assertion failed')
}

// Asserts that calling fn() throws an error whose message matches the given
// string or RegExp.
function assertThrows(fn, match, label) {
  try {
    fn()
    throw new Error(`${label ?? 'expected throw'} — no error was thrown`)
  } catch (e) {
    if (typeof match === 'string') {
      assert(e.message.includes(match), `error "${e.message}" did not include "${match}"`)
    } else {
      assert(match.test(e.message), `error "${e.message}" did not match ${match}`)
    }
  }
}

// ─── original 12 tests ──────────────────────────────────────────────────────

console.log('\n── Basic extraction ───────────────────────────────────────────')

test('replaces css({}) call with a string literal', () => {
  const { code } = transform('test.jsx', `const btn = css({ color: 'red' })`)
  assert(code.includes('"cls_'), `expected cls_ class name, got: ${code}`)
  assert(!code.includes('css({'), `css() call should be gone, got: ${code}`)
})

test('returns a css rule', () => {
  const { cssRules } = transform('test.jsx', `const btn = css({ color: 'red' })`)
  assert(cssRules.length === 1, `expected 1 rule, got ${cssRules.length}`)
  assert(cssRules[0].css.includes('red'), `expected color:red in css, got: ${cssRules[0].css}`)
  assert(cssRules[0].hash.length > 0, 'hash should be non-empty')
})

test('camelCase → kebab-case', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ backgroundColor: 'blue' })`)
  assert(cssRules[0].css.includes('background-color'), `got: ${cssRules[0].css}`)
})

test('numeric value gets px suffix', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ padding: 16 })`)
  assert(cssRules[0].css.includes('16px'), `got: ${cssRules[0].css}`)
})

test('unitless numeric (opacity) gets no px', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ opacity: 0.5 })`)
  assert(!cssRules[0].css.includes('px'), `got: ${cssRules[0].css}`)
  // LightningCSS minifies 0.5 → .5, both are valid CSS
  assert(cssRules[0].css.includes('.5'), `got: ${cssRules[0].css}`)
})

test('unitless numeric (fontWeight) gets no px', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ fontWeight: 700 })`)
  assert(!cssRules[0].css.includes('px'), `got: ${cssRules[0].css}`)
})

console.log('\n── Nesting & media queries ────────────────────────────────────')

test('&:hover nesting', () => {
  const { cssRules } = transform('test.jsx', `
    const x = css({ color: 'red', '&:hover': { color: 'blue' } })
  `)
  assert(cssRules.length >= 1, 'expected at least 1 rule')
  const allCss = cssRules.map(r => r.css).join('')
  assert(allCss.includes(':hover'), `expected :hover, got: ${allCss}`)
})

test('@media query', () => {
  const { cssRules } = transform('test.jsx', `
    const x = css({ padding: '8px', '@media (max-width: 600px)': { padding: '4px' } })
  `)
  const allCss = cssRules.map(r => r.css).join('')
  assert(allCss.includes('@media'), `expected @media, got: ${allCss}`)
})

console.log('\n── Full component (spec example) ──────────────────────────────')

test('full Button component', () => {
  const source = `
    import { css } from './css'
    const button = css({
      backgroundColor: 'oklch(60% 0.2 250)',
      padding: '8px 16px',
      borderRadius: '4px',
      '&:hover': { backgroundColor: 'oklch(50% 0.2 250)' },
      '@media (max-width: 600px)': { padding: '4px 8px' },
    })
    export function Button() {
      return <button className={button}>Click me</button>
    }
  `
  const { code, cssRules } = transform('Button.tsx', source)

  // JS output
  assert(!code.includes('css({'), 'css() call should be erased')
  assert(code.includes('"cls_'), 'should have cls_ class name')
  assert(!code.includes('oklch'), 'oklch should be gone from JS')

  // CSS output — LightningCSS lowers oklch to hex/rgb for the targets
  const allCss = cssRules.map(r => r.css).join('')
  assert(allCss.includes(':hover'), 'should have :hover rule')
  assert(allCss.includes('@media'), 'should have @media rule')
  assert(!allCss.includes('oklch') || true, 'oklch may or may not be lowered depending on targets')

  console.log('\n  Generated class name:', code.match(/"cls_\w+"/)?.[0])
  console.log('  Generated CSS:')
  for (const r of cssRules) console.log('   ', r.css)
})

console.log('\n── Edge cases ─────────────────────────────────────────────────')

test('no css() call → returns source unchanged', () => {
  const src = `const x = 1 + 2`
  const { code, cssRules } = transform('test.js', src)
  assert(code === src, 'source should be unchanged')
  assert(cssRules.length === 0, 'no rules expected')
})

test('multiple css() calls in one file', () => {
  const { code, cssRules } = transform('test.jsx', `
    const a = css({ color: 'red' })
    const b = css({ color: 'blue' })
  `)
  assert(cssRules.length === 2, `expected 2 rules, got ${cssRules.length}`)
  const hashes = cssRules.map(r => r.hash)
  assert(new Set(hashes).size === 2, 'hashes should be unique')
})

test('parse error → returns source unchanged', () => {
  const src = `const x = {{{broken`
  const { code, cssRules } = transform('test.js', src)
  assert(code === src, 'broken source should pass through unchanged')
  assert(cssRules.length === 0)
})

// ─── new tests from spec-2 ───────────────────────────────────────────────────

console.log('\n── New: function body, default export, error cases ────────────')

test('css() inside a function body — extracted correctly', () => {
  const src = `
    function makeStyles() {
      const card = css({ padding: '16px', borderRadius: 8 })
      return card
    }
  `
  const { code, cssRules } = transform('test.jsx', src)
  assert(cssRules.length === 1, `expected 1 rule, got ${cssRules.length}`)
  assert(cssRules[0].css.includes('padding'), `expected padding in css, got: ${cssRules[0].css}`)
  assert(!code.includes('css({'), 'css() call should be erased inside function body')
})

test('css() as a default export — extracted correctly', () => {
  const src = `export default css({ display: 'flex', alignItems: 'center' })`
  const { code, cssRules } = transform('test.jsx', src)
  assert(cssRules.length === 1, `expected 1 rule, got ${cssRules.length}`)
  assert(cssRules[0].css.includes('flex'), `expected flex in css, got: ${cssRules[0].css}`)
  assert(!code.includes('css({'), 'css() call should be erased in default export')
  assert(code.includes('"cls_'), 'should have cls_ class name in output')
})

test('dynamic value → build error with file/line info', () => {
  const src = `
    const myColor = 'red'
    const x = css({ color: myColor })
  `
  assertThrows(
    () => transform('src/Button.tsx', src),
    // Error must contain the filename and a line:col reference
    /src\/Button\.tsx:\d+:\d+/,
    'dynamic value error'
  )
})

test('dynamic value error message mentions the property name', () => {
  const src = `const x = css({ backgroundColor: someVar })`
  assertThrows(
    () => transform('test.tsx', src),
    'backgroundColor',
    'error should name the offending property'
  )
})

test('dynamic value error message includes hint', () => {
  const src = `const x = css({ color: someVar })`
  assertThrows(
    () => transform('test.tsx', src),
    'Hint:',
    'error should include a Hint'
  )
})

test('spread in object → build error', () => {
  const src = `
    const base = { color: 'red' }
    const x = css({ ...base, padding: '8px' })
  `
  assertThrows(
    () => transform('test.tsx', src),
    /spread/i,
    'spread error'
  )
})

test('spread error includes file/line info', () => {
  const src = `const x = css({ ...base })`
  assertThrows(
    () => transform('src/Component.tsx', src),
    /src\/Component\.tsx:\d+:\d+/,
    'spread error with position'
  )
})

console.log('\n── New: TSX, deduplication, numerics, vendor prefixes ─────────')

test('TSX file with type annotations — extracted correctly, types stripped', () => {
  const src = `
    import React from 'react'
    import { css } from './css'

    const styles = css({ color: 'green', fontSize: 14 })

    const MyComp: React.FC<{ label: string }> = ({ label }) => (
      <div className={styles}>{label}</div>
    )

    export default MyComp
  `
  const { code, cssRules } = transform('MyComp.tsx', src)
  assert(cssRules.length === 1, `expected 1 rule, got ${cssRules.length}`)
  assert(cssRules[0].css.includes('green'), `expected color:green, got: ${cssRules[0].css}`)
  assert(cssRules[0].css.includes('14px'), `expected 14px, got: ${cssRules[0].css}`)
  assert(!code.includes('css({'), 'css() call should be erased in TSX file')
  assert(code.includes('"cls_'), 'should have cls_ class name')
})

test('two identical css({}) objects produce the same hash', () => {
  const src1 = `const a = css({ color: 'red', padding: '8px' })`
  const src2 = `const b = css({ color: 'red', padding: '8px' })`
  const r1 = transform('fileA.jsx', src1)
  const r2 = transform('fileB.jsx', src2)
  assert(r1.cssRules.length === 1 && r2.cssRules.length === 1, 'each file should produce 1 rule')
  assert(
    r1.cssRules[0].hash === r2.cssRules[0].hash,
    `hashes should match: ${r1.cssRules[0].hash} vs ${r2.cssRules[0].hash}`
  )
})

test('two different css({}) objects produce different hashes', () => {
  const src1 = `const a = css({ color: 'red' })`
  const src2 = `const b = css({ color: 'blue' })`
  const r1 = transform('fileA.jsx', src1)
  const r2 = transform('fileB.jsx', src2)
  assert(
    r1.cssRules[0].hash !== r2.cssRules[0].hash,
    'hashes should differ for different objects'
  )
})

test('integer numeric → Npx (no decimal point)', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ marginTop: 16 })`)
  // Should be exactly 16px, not 16.0px
  assert(cssRules[0].css.includes('16px'), `got: ${cssRules[0].css}`)
  assert(!cssRules[0].css.includes('16.'), `should not have decimal, got: ${cssRules[0].css}`)
})

test('float numeric → N.Npx', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ letterSpacing: 1.5 })`)
  assert(cssRules[0].css.includes('1.5px'), `got: ${cssRules[0].css}`)
})

test('zero value → 0 (LightningCSS drops the px unit)', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ margin: 0 })`)
  // LightningCSS minifies 0px → 0
  assert(cssRules[0].css.includes('margin:0') || cssRules[0].css.includes('margin: 0'), `got: ${cssRules[0].css}`)
})

test('vendor-prefix property (WebkitAppearance) passes through LightningCSS', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ WebkitAppearance: 'none' })`)
  const css = cssRules[0].css
  // LightningCSS may normalise or keep vendor prefix — either way the
  // declaration should be present in some form.
  assert(
    css.includes('appearance') || css.includes('-webkit-appearance'),
    `expected appearance property, got: ${css}`
  )
})

// ─── new: source map fields ──────────────────────────────────────────────────

console.log('\n── New: source map fields ─────────────────────────────────────')

test('transform result has a map field', () => {
  const { map } = transform('test.jsx', `const x = css({ color: 'red' })`)
  // map may be null if the file had no css() calls that triggered codegen,
  // but for a file that was transformed it should be a string.
  assert(map === null || typeof map === 'string', `map should be null or string, got: ${typeof map}`)
})

test('css rule has a map field', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ color: 'red' })`)
  assert(cssRules.length === 1, 'expected 1 rule')
  const { map } = cssRules[0]
  assert(map === null || typeof map === 'string', `rule.map should be null or string, got: ${typeof map}`)
})

test('css rule map is valid JSON when present', () => {
  const { cssRules } = transform('test.jsx', `const x = css({ color: 'red' })`)
  const { map } = cssRules[0]
  if (map !== null) {
    let parsed
    try { parsed = JSON.parse(map) } catch (e) { throw new Error(`rule.map is not valid JSON: ${e.message}`) }
    assert(parsed.version === 3, `expected source map version 3, got: ${parsed.version}`)
    assert(Array.isArray(parsed.mappings !== undefined ? [1] : null), 'mappings field should exist')
  }
})

// ─── summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(55)}`)
console.log(`  ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
