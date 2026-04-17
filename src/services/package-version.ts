import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { getRootPath } from '@vscode-use/utils'

const packageVersionCache = new Map<string, string>()

function getBasePath(resolveFrom?: string) {
  if (!resolveFrom)
    return getRootPath() || process.cwd()

  return path.extname(resolveFrom)
    ? path.dirname(resolveFrom)
    : resolveFrom
}

export async function resolveInstalledPackageVersion(pkgName: string, resolveFrom?: string) {
  if (!pkgName)
    return

  const basePath = getBasePath(resolveFrom)
  const cacheKey = `${basePath}::${pkgName}`
  if (packageVersionCache.has(cacheKey))
    return packageVersionCache.get(cacheKey)

  const requireBase = path.resolve(basePath, 'package.json')
  const require = createRequire(requireBase)
  let pkgJsonPath = ''

  try {
    pkgJsonPath = require.resolve(`${pkgName}/package.json`)
  }
  catch {
    return
  }

  try {
    const pkgJson = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf-8'))
    const version = typeof pkgJson?.version === 'string' ? pkgJson.version : undefined
    if (version)
      packageVersionCache.set(cacheKey, version)
    return version
  }
  catch {}
}

export function clearPackageVersionCache() {
  packageVersionCache.clear()
}
