import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { getRootPath } from '@vscode-use/utils'

async function getResolutionBase(resolveFrom?: string) {
  if (!resolveFrom)
    return getRootPath() || process.cwd()

  try {
    const stat = await fsp.stat(resolveFrom)
    return stat.isFile() ? path.dirname(resolveFrom) : resolveFrom
  }
  catch {
    return path.basename(resolveFrom) === 'package.json' ? path.dirname(resolveFrom) : resolveFrom
  }
}

async function resolveManifestCandidate(candidate: string) {
  try {
    const realPath = await fsp.realpath(candidate)
    return (await fsp.stat(realPath)).isFile() ? realPath : undefined
  }
  catch {}
}

export async function resolvePackageManifest(packageName: string, resolveFrom?: string) {
  const segments = packageName.split('/')
  if (!packageName
    || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))
    || (packageName.startsWith('@') ? segments.length !== 2 : segments.length !== 1)) {
    return
  }

  const basePath = await getResolutionBase(resolveFrom)
  const localRequire = createRequire(path.resolve(basePath, 'package.json'))

  try {
    return await resolveManifestCandidate(localRequire.resolve(`${packageName}/package.json`))
  }
  catch {}

  for (const searchPath of localRequire.resolve.paths(packageName) || []) {
    const resolved = await resolveManifestCandidate(path.join(searchPath, ...packageName.split('/'), 'package.json'))
    if (resolved)
      return resolved
  }

  try {
    let current = path.dirname(localRequire.resolve(packageName))
    const root = path.parse(current).root
    while (current !== root) {
      const candidate = await resolveManifestCandidate(path.join(current, 'package.json'))
      if (candidate) {
        try {
          const manifest = JSON.parse(await fsp.readFile(candidate, 'utf8'))
          if (manifest?.name === packageName)
            return candidate
        }
        catch {}
      }
      current = path.dirname(current)
    }
  }
  catch {}
}
