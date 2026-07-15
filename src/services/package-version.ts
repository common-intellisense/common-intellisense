import fsp from 'node:fs/promises'
import { resolvePackageManifest } from './package-manifest'

interface VersionCacheEntry {
  version: string
  packageJsonPath: string
  mtimeMs: number
  size: number
}

const packageVersionCache = new Map<string, VersionCacheEntry>()

export async function resolveInstalledPackageVersion(pkgName: string, resolveFrom?: string) {
  if (!pkgName)
    return

  const cacheKey = `${resolveFrom || ''}::${pkgName}`
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

  const pkgJsonPath = await resolvePackageManifest(pkgName, resolveFrom)
  if (!pkgJsonPath)
    return

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
