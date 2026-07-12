import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { getRootPath } from '@vscode-use/utils'

interface VersionCacheEntry {
  version: string
  packageJsonPath: string
  mtimeMs: number
  size: number
}

const packageVersionCache = new Map<string, VersionCacheEntry>()

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
  const cached = packageVersionCache.get(cacheKey)
  if (cached) {
    try {
      const stat = await fsp.stat(cached.packageJsonPath)
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size)
        return cached.version
    }
    catch {}
    packageVersionCache.delete(cacheKey)
  }

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
    const [content, stat] = await Promise.all([
      fsp.readFile(pkgJsonPath, 'utf-8'),
      fsp.stat(pkgJsonPath),
    ])
    const pkgJson = JSON.parse(content)
    const version = typeof pkgJson?.version === 'string' ? pkgJson.version : undefined
    if (version)
      packageVersionCache.set(cacheKey, { version, packageJsonPath: pkgJsonPath, mtimeMs: stat.mtimeMs, size: stat.size })
    return version
  }
  catch {}
}

export function clearPackageVersionCache() {
  packageVersionCache.clear()
}
