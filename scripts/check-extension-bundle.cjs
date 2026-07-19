const fs = require('node:fs')
const path = require('node:path')

const bundlePath = path.resolve(__dirname, '..', 'dist', 'index.js')
if (!fs.existsSync(bundlePath))
  throw new Error(`Extension bundle is missing: ${bundlePath}`)

const bundle = fs.readFileSync(bundlePath, 'utf8')
const externalSemver = /\brequire\(\s*(['"])semver\1\s*\)/
if (externalSemver.test(bundle))
  throw new Error('dist/index.js externalizes semver, but the VSIX does not ship node_modules')

console.log('Extension bundle check passed: semver is bundled')
