import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
  ],
  format: ['cjs'],
  shims: false,
  dts: false,
  external: [
    'vscode',
  ],
  // VSIX packaging excludes node_modules and uses --no-dependencies, so runtime
  // dependencies must be part of the single extension bundle.
  noExternal: [
    'semver',
  ],
})
