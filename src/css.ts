// src/css.ts
// At runtime this is a no-op. The Vite plugin replaces all calls with a
// static class name string at build time, so this code only runs in
// environments that don't go through the plugin (tests, SSR without transform).
export function css(_styles: Record<string, unknown>): string {
  return ''
}