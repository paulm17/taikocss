// src/css.ts
//
// Runtime shim — used by Jest, Vitest (node mode), ts-node, and any other
// environment that doesn't go through the Vite plugin transform.
//
// At build time the Vite plugin replaces every call with a static class-name
// string and injects virtual CSS modules, so this code is never reached in a
// production bundle.

export function css(_styles: Record<string, unknown>): string {
  return ''
}

export function globalCss(
  _strings: TemplateStringsArray,
  ..._values: unknown[]
): void {}

export function keyframes(
  _strings: TemplateStringsArray,
  ..._values: unknown[]
): string {
  return ''
}

export function container(..._args: unknown[]): Record<string, unknown> {
  return {}
}