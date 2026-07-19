import type { Stats } from 'node:fs'
import fsp from 'node:fs/promises'
import { resolvePackageManifest } from './package-manifest'

interface VersionCacheEntry {
  version: string
  packageJsonPath: string
  dev: number
  ino: number
  mtimeMs: number
  ctimeMs: number
  size: number
}

type VersionFileStat = Pick<Stats, 'dev' | 'ino' | 'mtimeMs' | 'ctimeMs' | 'size'>

const packageVersionCache = new Map<string, VersionCacheEntry>()

function matchesStat(left: VersionFileStat, right: VersionFileStat) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.size === right.size
}

async function readStablePackageManifest(packageJsonPath: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = await fsp.open(packageJsonPath, 'r')
    try {
      const before = await handle.stat()
      const content = await handle.readFile('utf8')
      const after = await handle.stat()
      const current = await fsp.stat(packageJsonPath)
      if (matchesStat(before, after) && matchesStat(after, current))
        return { content, stat: after }
    }
    finally {
      await handle.close()
    }
  }
}

export async function resolveInstalledPackageVersion(pkgName: string, resolveFrom?: string) {
  if (!pkgName)
    return

  const cacheKey = `${resolveFrom || ''}::${pkgName}`
  const cached = packageVersionCache.get(cacheKey)
  if (cached) {
    try {
      const stat = await fsp.stat(cached.packageJsonPath)
      if (matchesStat(cached, stat))
        return cached.version
    }
    catch {}
    packageVersionCache.delete(cacheKey)
  }

  const pkgJsonPath = await resolvePackageManifest(pkgName, resolveFrom)
  if (!pkgJsonPath)
    return

  try {
    const snapshot = await readStablePackageManifest(pkgJsonPath)
    if (!snapshot)
      return
    const pkgJson = JSON.parse(snapshot.content)
    const version = typeof pkgJson?.version === 'string' ? pkgJson.version : undefined
    if (version) {
      const { dev, ino, mtimeMs, ctimeMs, size } = snapshot.stat
      packageVersionCache.set(cacheKey, { version, packageJsonPath: pkgJsonPath, dev, ino, mtimeMs, ctimeMs, size })
    }
    return version
  }
  catch {}
}

export function clearPackageVersionCache() {
  packageVersionCache.clear()
}
