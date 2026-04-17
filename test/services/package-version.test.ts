import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearPackageVersionCache, resolveInstalledPackageVersion } from '../../src/services/package-version'

describe('package-version service', () => {
  let tempDir = ''

  beforeEach(async () => {
    clearPackageVersionCache()
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'common-intellisense-'))
    await fsp.writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ name: 'fixture' }))
  })

  afterEach(async () => {
    clearPackageVersionCache()
    if (tempDir)
      await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('resolves installed package versions from local package manifests', async () => {
    const pkgDir = path.join(tempDir, 'node_modules', 'element-plus')
    await fsp.mkdir(pkgDir, { recursive: true })
    await fsp.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: 'element-plus',
      version: '2.9.7',
    }))

    await expect(resolveInstalledPackageVersion('element-plus', tempDir)).resolves.toBe('2.9.7')
  })

  it('does not cache missing packages', async () => {
    await expect(resolveInstalledPackageVersion('element-plus', tempDir)).resolves.toBeUndefined()

    const pkgDir = path.join(tempDir, 'node_modules', 'element-plus')
    await fsp.mkdir(pkgDir, { recursive: true })
    await fsp.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: 'element-plus',
      version: '2.9.7',
    }))

    await expect(resolveInstalledPackageVersion('element-plus', tempDir)).resolves.toBe('2.9.7')
  })

  it('returns refreshed versions after clearing the cache', async () => {
    const pkgDir = path.join(tempDir, 'node_modules', 'element-plus')
    const manifestPath = path.join(pkgDir, 'package.json')
    await fsp.mkdir(pkgDir, { recursive: true })
    await fsp.writeFile(manifestPath, JSON.stringify({
      name: 'element-plus',
      version: '2.9.7',
    }))

    await expect(resolveInstalledPackageVersion('element-plus', tempDir)).resolves.toBe('2.9.7')

    await fsp.writeFile(manifestPath, JSON.stringify({
      name: 'element-plus',
      version: '2.9.8',
    }))

    await expect(resolveInstalledPackageVersion('element-plus', tempDir)).resolves.toBe('2.9.7')

    clearPackageVersionCache()

    await expect(resolveInstalledPackageVersion('element-plus', tempDir)).resolves.toBe('2.9.8')
  })
})
