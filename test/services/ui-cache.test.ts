import { describe, expect, it, vi } from 'vitest'
import { cacheMap, clearUICache, disposeRootPackageCache, disposeRootWatchers, getCacheMap, pkgUIConfigMap, rootPkgCache, urlCache } from '../../src/services/ui-cache'

describe('ui-cache service', () => {
  it('clears disposed watcher handles so rebuilds can register them again', () => {
    rootPkgCache.clear()
    const stopRoot = vi.fn()
    const stopWorkspace = vi.fn()
    rootPkgCache.set('r', { rootPkgPath: '/tmp/package.json', rootPkg: {}, isMonorepo: true, stopRoot, stopWorkspace })

    disposeRootWatchers()

    expect(stopRoot).toHaveBeenCalledOnce()
    expect(stopWorkspace).toHaveBeenCalledOnce()
    expect(rootPkgCache.get('r')).toMatchObject({ stopRoot: undefined, stopWorkspace: undefined })
  })

  it('disposes and removes one unused workspace root cache', () => {
    rootPkgCache.clear()
    const stopRoot = vi.fn()
    const stopWorkspace = vi.fn()
    rootPkgCache.set('/workspace-a', { rootPkgPath: '/workspace-a/package.json', rootPkg: {}, isMonorepo: true, stopRoot, stopWorkspace })
    rootPkgCache.set('/workspace-b', { rootPkgPath: '/workspace-b/package.json', rootPkg: {}, isMonorepo: true })

    disposeRootPackageCache('/workspace-a')

    expect(stopRoot).toHaveBeenCalledOnce()
    expect(stopWorkspace).toHaveBeenCalledOnce()
    expect(rootPkgCache.has('/workspace-a')).toBe(false)
    expect(rootPkgCache.has('/workspace-b')).toBe(true)
  })

  it('exports cache maps and clearUICache clears them', () => {
    // ensure maps are present
    cacheMap.set('x', { dummy: true } as any)
    pkgUIConfigMap.set('p', { propsConfig: {}, componentsConfig: {} } as any)
    urlCache.set('u', { uis: [], pkg: 'p' } as any)
    const stopRoot = vi.fn()
    rootPkgCache.set('r', { rootPkgPath: '/tmp', rootPkg: {}, isMonorepo: false, stopRoot })

    const gm = getCacheMap()
    expect(gm).toBe(cacheMap)
    expect(cacheMap.size).toBeGreaterThan(0)
    expect(pkgUIConfigMap.size).toBeGreaterThan(0)
    expect(urlCache.size).toBeGreaterThan(0)
    expect(rootPkgCache.size).toBeGreaterThan(0)

    clearUICache()

    expect(cacheMap.size).toBe(0)
    expect(pkgUIConfigMap.size).toBe(0)
    expect(urlCache.size).toBe(0)
    expect(rootPkgCache.size).toBe(0)
    expect(stopRoot).toHaveBeenCalledOnce()
  })
})
