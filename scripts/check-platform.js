// scripts/check-platform.js
// Runs as the postinstall hook. Warns (never errors) when the current platform
// has no prebuilt binary. A failing postinstall blocks the entire install, so
// the entire script is wrapped in a try/catch that silently exits on any error.

try {
  const supported = [
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
    'win32-x64',
  ]

  const current = `${process.platform}-${process.arch}`
  const ok = supported.some(p => current.startsWith(p))

  if (!ok) {
    console.warn(
      `\ntaikocss: no prebuilt binary available for ${current}.\n` +
      `Supported platforms: ${supported.join(', ')}.\n` +
      `You will need to build from source: npm run build\n` +
      `(Requires Rust: https://rustup.rs)\n`
    )
  }
} catch {
  // Never block the install.
}