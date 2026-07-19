import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('resolves packages whose exports do not expose package.json', async () => {
    const pkgDir = path.join(tempDir, 'node_modules', 'export-locked-ui')
    await fsp.mkdir(path.join(pkgDir, 'dist'), { recursive: true })
    await fsp.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: 'export-locked-ui',
      version: '2.3.0',
      exports: { '.': './dist/index.js' },
    }))
    await fsp.writeFile(path.join(pkgDir, 'dist', 'index.js'), 'module.exports = {}')

    await expect(resolveInstalledPackageVersion('export-locked-ui', tempDir)).resolves.toBe('2.3.0')
  })

  it('resolves npm aliases by their consuming dependency key', async () => {
    const pkgDir = path.join(tempDir, 'node_modules', 'antd')
    await fsp.mkdir(pkgDir, { recursive: true })
    await fsp.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: '@corp/antd-fork',
      version: '5.2.1',
    }))

    await expect(resolveInstalledPackageVersion('antd', tempDir)).resolves.toBe('5.2.1')
  })

  it('keeps dotted directories as resolution bases', async () => {
    const dottedDir = path.join(tempDir, 'packages', 'ui.v2')
    const pkgDir = path.join(dottedDir, 'node_modules', 'element-plus')
    await fsp.mkdir(pkgDir, { recursive: true })
    await fsp.writeFile(path.join(dottedDir, 'package.json'), JSON.stringify({ name: 'dotted-fixture' }))
    await fsp.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'element-plus', version: '2.8.0' }))

    await expect(resolveInstalledPackageVersion('element-plus', dottedDir)).resolves.toBe('2.8.0')
    await expect(resolveInstalledPackageVersion('element-plus', path.join(dottedDir, 'package.json'))).resolves.toBe('2.8.0')
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

  it('retries when an opened manifest is replaced before its metadata is validated', async () => {
    const pkgDir = path.join(tempDir, 'node_modules', 'element-plus')
    const manifestPath = path.join(pkgDir, 'package.json')
    await fsp.mkdir(pkgDir, { recursive: true })
    await fsp.writeFile(manifestPath, JSON.stringify({ name: 'element-plus', version: '2.9.8' }))
    const current = await fsp.stat(manifestPath)
    const realOpen = fsp.open.bind(fsp)
    const oldStat = { ...current, ino: current.ino + 1 }
    const openSpy = vi.spyOn(fsp, 'open')
      .mockResolvedValueOnce({
        stat: vi.fn().mockResolvedValue(oldStat),
        readFile: vi.fn().mockResolvedValue(JSON.stringify({ name: 'element-plus', version: '2.9.7' })),
        close: vi.fn(),
      } as any)
      .mockImplementation(realOpen as any)

    try {
      await expect(resolveInstalledPackageVersion('element-plus', tempDir)).resolves.toBe('2.9.8')
      await expect(resolveInstalledPackageVersion('element-plus', tempDir)).resolves.toBe('2.9.8')
    }
    finally {
      openSpy.mockRestore()
    }
  })

  it('refreshes cached versions when the installed package manifest changes', async () => {
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

    await expect(resolveInstalledPackageVersion('element-plus', tempDir)).resolves.toBe('2.9.8')
  })
})
